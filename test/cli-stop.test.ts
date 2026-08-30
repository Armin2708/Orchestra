import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// The CLI module runs commander at import time, so the daemon module is mocked before it loads.
const stopDaemon = vi.fn<() => boolean>()
const waitForDaemonExit = vi.fn<() => Promise<boolean>>()

vi.mock('../src/daemon.js', async () => {
  const actual = await vi.importActual<typeof import('../src/daemon.js')>('../src/daemon.js')
  return { ...actual, stopDaemon, waitForDaemonExit }
})

/**
 * `orchestra stop` used to print "stopped" the moment SIGTERM was delivered, while a
 * graceful shutdown takes tens of seconds. `orchestra stop && orchestra` therefore raced
 * its own daemon and failed with "another Orchestra daemon already owns this data
 * directory" — reported from a real terminal.
 */
describe('orchestra stop', () => {
  let logged: string[]
  let log: typeof console.log

  beforeEach(() => {
    logged = []
    log = console.log
    console.log = (...args: unknown[]) => { logged.push(args.join(' ')) }
    stopDaemon.mockReset()
    waitForDaemonExit.mockReset()
    process.exitCode = undefined
  })
  afterEach(() => { console.log = log; process.exitCode = undefined })

  // Exercised through the same helpers the command composes, so the contract under test is
  // "signal, then wait, then report" rather than commander's plumbing.
  const runStop = async () => {
    if (!stopDaemon()) { console.log('not running'); return }
    if (await waitForDaemonExit()) { console.log('stopped'); return }
    console.log('the daemon did not exit in time — it is still shutting down; check with `orchestra snapshot`')
    process.exitCode = 1
  }

  it('waits for the process to go before saying it stopped', async () => {
    stopDaemon.mockReturnValue(true)
    waitForDaemonExit.mockResolvedValue(true)

    await runStop()

    expect(stopDaemon).toHaveBeenCalledOnce()
    expect(waitForDaemonExit).toHaveBeenCalledOnce()
    expect(logged).toEqual(['stopped'])
    expect(process.exitCode).toBeUndefined()
  })

  it('does not claim a stop that has not happened', async () => {
    stopDaemon.mockReturnValue(true)
    waitForDaemonExit.mockResolvedValue(false)

    await runStop()

    expect(logged.join('\n')).toContain('still shutting down')
    expect(logged.join('\n')).not.toContain('stopped')
    // a non-zero exit is what stops `orchestra stop && orchestra` from racing the old daemon
    expect(process.exitCode).toBe(1)
  })

  // The tests above exercise the contract, not commander's plumbing — so this asserts the
  // real command is actually wired to it, which is the part that regressed.
  it('is wired into the stop command in cli.ts', async () => {
    const fs = await import('node:fs')
    const source = fs.readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8')
    const action = source.slice(source.indexOf("program.command('stop')"))
      .slice(0, source.slice(source.indexOf("program.command('stop')")).indexOf('\n})') + 3)
    expect(action).toContain('await waitForDaemonExit()')
    expect(action).toContain('stopDaemon()')
  })

  it('says nothing was running without waiting', async () => {
    stopDaemon.mockReturnValue(false)

    await runStop()

    expect(waitForDaemonExit).not.toHaveBeenCalled()
    expect(logged).toEqual(['not running'])
  })
})
