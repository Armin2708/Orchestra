import { spawn } from 'node:child_process'
import { InvalidArgumentError } from 'commander'
import { api, projectPath } from './client.js'
import { baseUrl, ensureDaemon } from './daemon.js'
import { formatDoctorReport } from './doctor-cli.js'
import { type DoctorProvider } from './environment-compatibility.js'
import { installHooks, installWorkflows, type HookScope, type InstallProvider } from './install.js'
import {
  runOperatorReadinessDoctor,
  type OperatorDoctorReport,
} from './readiness-doctor.js'

export type InitCliDeps = {
  runDoctor?: (provider: DoctorProvider) => OperatorDoctorReport
  formatReport?: (report: OperatorDoctorReport) => string
  startDaemon?: () => Promise<boolean>
  installProviderHooks?: (scope: HookScope, options: { provider: InstallProvider }) => void
  installWorkflowPack?: (scope: HookScope) => string[]
  registerBoard?: () => Promise<unknown>
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
  const installWorkflowPack = deps.installWorkflowPack ?? installWorkflows
  const openBrowser = deps.openBrowser ?? defaultOpenBrowser
  const boardUrl = deps.boardUrl ?? baseUrl
  const output = deps.output ?? console.log
  const registerBoard = deps.registerBoard
    ?? (() => api('POST', '/boards/resolve', { project_path: projectPath(), create: true }))

  return async (options: {
    provider: DoctorProvider
    project?: boolean
    open: boolean
    workflows?: boolean
  }): Promise<void> => {
    const report = runDoctor(options.provider)
    output(formatReport(report))
    if (!report.ready) {
      output('Environment is not fully ready — continuing anyway; fix the items above, then re-run `orchestra doctor`.')
    }
    if (!await startDaemon()) {
      throw new Error('daemon failed to start — run `orchestra serve` in the foreground and read the error')
    }
    // init is the operator acting — it registers this folder as a project explicitly
    // (sessions can no longer auto-create boards)
    await registerBoard()
    const url = boardUrl()
    const scope: HookScope = options.project ? 'project' : 'global'
    installProviderHooks(scope, { provider: options.provider })
    // --no-workflows opts out; commander leaves `workflows` undefined when the option is absent
    const workflows = options.workflows === false ? [] : installWorkflowPack(scope)
    if (options.open) openBrowser(url)
    output([
      `Orchestra is running on ${url}`,
      `Hooks installed (${options.provider}); new agent sessions in hooked projects join the board automatically.`,
      ...(options.workflows === false
        ? []
        : [`Workflow commands installed (${workflows.length} written) into .claude/commands.`]),
      'Next: open the board and hire your first agent (+ Hire), or run `orchestra remote` for phone access.',
    ].join('\n'))
  }
}
