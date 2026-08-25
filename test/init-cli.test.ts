import { Command } from 'commander'
import { describe, expect, it } from 'vitest'
import { buildInitAction, initProviderOption, type InitCliDeps } from '../src/init-cli.js'

type Call = string

const harness = (overrides: Partial<InitCliDeps> = {}) => {
  const calls: Call[] = []
  const lines: string[] = []
  const deps: InitCliDeps = {
    runDoctor: (provider) => {
      calls.push(`doctor:${provider}`)
      return {
        ready: true, status: 'validated', provider, checks: [],
      } as never
    },
    formatReport: () => 'DOCTOR REPORT',
    startDaemon: async () => { calls.push('daemon'); return true },
    registerBoard: async () => { calls.push('board') },
    installProviderHooks: (scope, options) => { calls.push(`hooks:${scope}:${options.provider}`) },
    installWorkflowPack: (scope) => { calls.push(`workflows:${scope}`); return ['build.md'] },
    openBrowser: (url) => { calls.push(`open:${url}`) },
    boardUrl: () => 'http://127.0.0.1:4820',
    output: (line) => { lines.push(line) },
    ...overrides,
  }
  const program = new Command()
  program.exitOverride()
  program.command('init')
    .option('--provider <provider>', 'claude|codex|both', initProviderOption, 'both')
    .option('--project')
    .option('--no-open')
    .option('--no-workflows')
    .action(buildInitAction(deps))
  const run = (argv: string[]) => program.parseAsync(['node', 'orchestra', ...argv])
  return { calls, lines, run }
}

describe('orchestra init', () => {
  it('runs doctor, starts the daemon, installs hooks then workflows, opens the board — in that order', async () => {
    const { calls, lines, run } = await Promise.resolve(harness())
    await run(['init'])
    expect(calls).toEqual([
      'doctor:both', 'daemon', 'board', 'hooks:global:both', 'workflows:global', 'open:http://127.0.0.1:4820',
    ])
    expect(lines.join('\n')).toContain('DOCTOR REPORT')
    expect(lines.join('\n')).toContain('http://127.0.0.1:4820')
    expect(lines.join('\n')).toContain('hire your first agent')
  })

  it('honors --provider, --project, and --no-open', async () => {
    const { calls, run } = harness()
    await run(['init', '--provider', 'claude', '--project', '--no-open'])
    expect(calls).toEqual(['doctor:claude', 'daemon', 'board', 'hooks:project:claude', 'workflows:project'])
  })

  it('skips the workflow pack under --no-workflows', async () => {
    const { calls, lines, run } = harness()
    await run(['init', '--no-workflows', '--no-open'])
    expect(calls).toEqual(['doctor:both', 'daemon', 'board', 'hooks:global:both'])
    expect(lines.join('\n')).not.toContain('Workflow commands installed')
  })

  it('continues past a NOT READY doctor report but surfaces it as a warning', async () => {
    const { calls, lines, run } = harness({
      runDoctor: (provider) => ({ ready: false, status: 'unsupported', provider, checks: [] } as never),
    })
    await run(['init'])
    expect(calls).toContain('daemon')
    expect(calls.some((call) => call.startsWith('hooks:'))).toBe(true)
    expect(lines.join('\n')).toContain('not fully ready')
  })

  it('fails hard when the daemon does not come up, before touching hooks', async () => {
    const { calls, run } = harness({ startDaemon: async () => false })
    await expect(run(['init'])).rejects.toThrow(/daemon/i)
    expect(calls.some((call) => call.startsWith('hooks:'))).toBe(false)
  })

  it('rejects an unknown provider', async () => {
    const { run } = harness()
    await expect(run(['init', '--provider', 'gemini'])).rejects.toThrow(/claude\|codex\|both/)
  })
})
