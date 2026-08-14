import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// The restart path is process-level, so this exercises the piece that actually broke:
// waitForDaemonExit must not report "gone" while the outgoing daemon is still alive.
// The old code replaced this with a fixed 5s budget, and a daemon draining hired agents
// takes ~33s — so the replacement was spawned into a still-held lease, refused, and the
// box was left with no daemon at all.

let home: string
let previousHome: string | undefined
let previousPort: string | undefined

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-restart-'))
  previousHome = process.env.ORCHESTRA_HOME
  previousPort = process.env.ORCHESTRA_PORT
  process.env.ORCHESTRA_HOME = home
  // a port nothing listens on: the liveness half of the check probes the daemon's port,
  // and the developer's own running daemon would otherwise answer and fail these
  process.env.ORCHESTRA_PORT = '45999'
})

afterEach(() => {
  if (previousHome === undefined) delete process.env.ORCHESTRA_HOME
  else process.env.ORCHESTRA_HOME = previousHome
  if (previousPort === undefined) delete process.env.ORCHESTRA_PORT
  else process.env.ORCHESTRA_PORT = previousPort
  fs.rmSync(home, { recursive: true, force: true })
})

const writePid = (pid: number) => {
  fs.mkdirSync(home, { recursive: true })
  fs.writeFileSync(path.join(home, 'daemon.pid'), String(pid))
}

describe('waitForDaemonExit', () => {
  it('reports the daemon gone when no pidfile records one', async () => {
    const { waitForDaemonExit } = await import('../src/daemon.js')
    await expect(waitForDaemonExit(2_000)).resolves.toBe(true)
  })

  it('reports gone once a recorded pid no longer exists', async () => {
    // a pid that cannot be running: reserve one by spawning and reaping nothing
    writePid(2_147_483_646)
    const { waitForDaemonExit } = await import('../src/daemon.js')
    await expect(waitForDaemonExit(2_000)).resolves.toBe(true)
  })

  it('does NOT report gone while the recorded process is still alive — the whole bug', async () => {
    // our own pid is by definition still running, standing in for a daemon mid-drain
    writePid(process.pid)
    const { waitForDaemonExit } = await import('../src/daemon.js')
    const started = Date.now()
    // times out rather than falsely clearing the way for a replacement
    await expect(waitForDaemonExit(600)).resolves.toBe(false)
    // and it actually waited, rather than returning immediately
    expect(Date.now() - started).toBeGreaterThanOrEqual(500)
  })

  it('tolerates a corrupt pidfile instead of blocking a restart forever', async () => {
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(path.join(home, 'daemon.pid'), 'not-a-pid')
    const { waitForDaemonExit } = await import('../src/daemon.js')
    await expect(waitForDaemonExit(2_000)).resolves.toBe(true)
  })
})
