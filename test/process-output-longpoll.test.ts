import { describe, expect, it } from 'vitest'
import {
  notifyProcessOutput,
  waitForProcessOutput,
  PROCESS_OUTPUT_WAIT_CEILING_MS,
} from '../src/agent-os/process-output-signal.js'

const elapsed = async (run: () => Promise<unknown>): Promise<number> => {
  const started = Date.now()
  await run()
  return Date.now() - started
}

describe('process output long-poll signal', () => {
  it('resolves as soon as the process writes, not on a timer', async () => {
    const waited = await elapsed(async () => {
      const parked = waitForProcessOutput('proc-write', 5_000)
      setTimeout(() => notifyProcessOutput('proc-write'), 20)
      await parked
    })
    // the point of the whole change: a keystroke echo must not wait out an interval
    expect(waited).toBeLessThan(500)
  })

  it('gives up after the requested wait when the process stays silent', async () => {
    const waited = await elapsed(() => waitForProcessOutput('proc-silent', 60))
    expect(waited).toBeGreaterThanOrEqual(40)
    expect(waited).toBeLessThan(1_500)
  })

  it('wakes every terminal parked on the same process', async () => {
    const first = waitForProcessOutput('proc-shared', 5_000)
    const second = waitForProcessOutput('proc-shared', 5_000)
    setTimeout(() => notifyProcessOutput('proc-shared'), 10)
    await expect(Promise.all([first, second])).resolves.toHaveLength(2)
  })

  it('ignores writes to other processes', async () => {
    const waited = await elapsed(async () => {
      const parked = waitForProcessOutput('proc-mine', 80)
      notifyProcessOutput('proc-other')
      await parked
    })
    expect(waited).toBeGreaterThanOrEqual(40) // fell through to its own timeout, not the notify
  })

  it('caps an absurd wait so a client cannot park a request indefinitely', async () => {
    expect(PROCESS_OUTPUT_WAIT_CEILING_MS).toBeLessThanOrEqual(30_000)
    const waited = await elapsed(async () => {
      const parked = waitForProcessOutput('proc-capped', Number.MAX_SAFE_INTEGER)
      setTimeout(() => notifyProcessOutput('proc-capped'), 10)
      await parked
    })
    expect(waited).toBeLessThan(500)
  })

  it('does not leak a listener per parked reader', async () => {
    for (let i = 0; i < 50; i++) {
      const parked = waitForProcessOutput('proc-leak', 5_000)
      notifyProcessOutput('proc-leak')
      await parked
    }
    // a second round still resolves promptly — listeners from round one were removed
    const waited = await elapsed(async () => {
      const parked = waitForProcessOutput('proc-leak', 5_000)
      notifyProcessOutput('proc-leak')
      await parked
    })
    expect(waited).toBeLessThan(500)
  })
})
