import { Command } from 'commander'
import { describe, expect, it, vi } from 'vitest'
import { registerFirstRunCommands } from '../src/first-run-cli.js'

const setup = (overrides: Parameters<typeof registerFirstRunCommands>[1] = {}) => {
  const output: string[] = []
  const program = new Command().name('orchestra').exitOverride()
  program.configureOutput({ writeErr: () => {}, writeOut: () => {} })
  registerFirstRunCommands(program, {
    cwd: () => '/workspace/project',
    ask: vi.fn(async (_question, defaultValue) => defaultValue),
    output: (line) => output.push(line),
    ...overrides,
  })
  const run = (...args: string[]) => program.parseAsync(['node', 'orchestra', ...args])
  return { output, run }
}

describe('first-run CLI registrar', () => {
  it('prints a machine-readable safe plan without applying changes', async () => {
    const applyPlan = vi.fn()
    const { output, run } = setup({ applyPlan })

    await run(
      'onboard',
      '--project', '/workspace/project',
      '--provider', 'codex',
      '--mode', 'native_subscription',
      '--hooks', 'off',
      '--telemetry', 'off',
      '--json',
    )

    expect(JSON.parse(output[0])).toMatchObject({
      provider: { id: 'codex', release_state: 'candidate' },
      defaults: { remote_access: 'off', usage_priced_api_fallback: 'off' },
      ready_for_managed_launch: false,
    })
    expect(applyPlan).not.toHaveBeenCalled()
  })

  it('applies only after an explicit flag', async () => {
    const applyPlan = vi.fn(() => ({ schema_version: 1 })) as any
    const { output, run } = setup({ applyPlan })
    await run(
      'onboard',
      '--project', '/workspace/project',
      '--provider', 'codex',
      '--mode', 'native_subscription',
      '--hooks', 'off',
      '--telemetry', 'off',
      '--apply',
    )
    expect(applyPlan).toHaveBeenCalledOnce()
    expect(output[0]).toContain('Configuration saved')
  })

  it('rejects an invalid provider before any action', async () => {
    const { run } = setup()
    await expect(run('onboard', '--provider', 'imaginary')).rejects.toThrow(
      'provider must be claude|codex|qwen|kimi',
    )
  })
})
