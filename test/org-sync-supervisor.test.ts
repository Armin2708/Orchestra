import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { superviseDaemonOrgSync } from '../src/org-sync/supervisor.js'
import { saveOrgCredential, clearOrgCredential, type OrgCredential } from '../src/org-sync/credentials.js'
import type { DaemonOrgSyncHandle, StartDaemonOrgSyncOptions } from '../src/org-sync/daemon-integration.js'

const credential = (orgId: string): OrgCredential => ({
  hubBaseUrl: 'http://localhost:4760/',
  orgId,
  deviceToken: 'orchestra_device_v1.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  deviceName: 'laptop',
})

// Records every start/stop so a test can assert the supervisor switched loops rather than
// leaking one, which is the failure that would quietly double-publish presence.
function recordingStart() {
  const started: string[] = []
  const stopped: string[] = []
  let live = 0
  const start = async (options: StartDaemonOrgSyncOptions): Promise<DaemonOrgSyncHandle | null> => {
    const loaded = await options.loadCredential!()
    if (!loaded) return null
    started.push(loaded.orgId)
    live += 1
    return {
      state: () => 'live',
      stop: async () => { stopped.push(loaded.orgId); live -= 1 },
    }
  }
  return { start, started, stopped, liveCount: () => live }
}

describe('superviseDaemonOrgSync', () => {
  let home: string

  beforeEach(async () => { home = await fs.mkdtemp(path.join(os.tmpdir(), 'orchestra-supervisor-')) })
  afterEach(async () => { await fs.rm(home, { recursive: true, force: true }) })

  it('starts nothing when no organization is joined', async () => {
    const rec = recordingStart()
    const supervisor = await superviseDaemonOrgSync({ home, watch: false, start: rec.start, output: () => {} })
    expect(rec.started).toEqual([])
    expect(supervisor.state()).toBe('off')
    expect(supervisor.orgId()).toBeNull()
    await supervisor.stop()
  })

  it('connects a running daemon when a credential appears — no restart', async () => {
    const rec = recordingStart()
    const supervisor = await superviseDaemonOrgSync({ home, watch: false, start: rec.start, output: () => {} })
    expect(supervisor.state()).toBe('off')

    await saveOrgCredential(credential('org_a'), home)
    await supervisor.reload()

    expect(rec.started).toEqual(['org_a'])
    expect(supervisor.state()).toBe('live')
    expect(supervisor.orgId()).toBe('org_a')
    await supervisor.stop()
  })

  it('stops syncing when the organization is left', async () => {
    await saveOrgCredential(credential('org_a'), home)
    const rec = recordingStart()
    const supervisor = await superviseDaemonOrgSync({ home, watch: false, start: rec.start, output: () => {} })
    expect(supervisor.state()).toBe('live')

    await clearOrgCredential(home)
    await supervisor.reload()

    expect(rec.stopped).toEqual(['org_a'])
    expect(supervisor.state()).toBe('off')
    expect(supervisor.orgId()).toBeNull()
    await supervisor.stop()
  })

  it('switches organizations by stopping the old loop before starting the new one', async () => {
    await saveOrgCredential(credential('org_a'), home)
    const rec = recordingStart()
    const supervisor = await superviseDaemonOrgSync({ home, watch: false, start: rec.start, output: () => {} })

    await saveOrgCredential(credential('org_b'), home)
    await supervisor.reload()

    expect(rec.started).toEqual(['org_a', 'org_b'])
    expect(rec.stopped).toEqual(['org_a'])
    expect(rec.liveCount()).toBe(1)
    expect(supervisor.orgId()).toBe('org_b')
    await supervisor.stop()
  })

  it('restart() replaces the loop even when the credential is unchanged', async () => {
    const rec = recordingStart()
    const supervisor = await superviseDaemonOrgSync({ home, watch: false, start: rec.start, output: () => {} })
    await saveOrgCredential(credential('org_a'), home)
    await supervisor.reload()
    expect(rec.started).toEqual(['org_a'])
    // reload() must still no-op on an unchanged credential…
    await supervisor.reload()
    expect(rec.started).toEqual(['org_a'])
    // …while restart() is the deliberate escape hatch for a terminal loop.
    await supervisor.restart()
    expect(rec.started).toEqual(['org_a', 'org_a'])
    expect(rec.stopped).toEqual(['org_a'])
    expect(rec.liveCount()).toBe(1)
    await supervisor.stop()
  })

  it('does not restart a healthy loop when the credential is rewritten unchanged', async () => {
    await saveOrgCredential(credential('org_a'), home)
    const rec = recordingStart()
    const supervisor = await superviseDaemonOrgSync({ home, watch: false, start: rec.start, output: () => {} })

    await saveOrgCredential(credential('org_a'), home)
    await supervisor.reload()
    await supervisor.reload()

    expect(rec.started).toEqual(['org_a'])
    expect(rec.stopped).toEqual([])
    await supervisor.stop()
  })

  it('picks up a join written by another process, without reload() being called', async () => {
    const rec = recordingStart()
    const supervisor = await superviseDaemonOrgSync({
      home, start: rec.start, output: () => {}, debounceMs: 10,
    })
    expect(supervisor.state()).toBe('off')

    // exactly what `orchestra org join` does, from a separate process
    await saveOrgCredential(credential('org_watched'), home)

    const deadline = Date.now() + 5_000
    while (supervisor.state() === 'off' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }

    expect(rec.started).toEqual(['org_watched'])
    expect(supervisor.state()).toBe('live')
    await supervisor.stop()
  })

  // Found on a real daemon: `org leave` dropped the connection and no later join ever
  // reconnected, because the awaited stop() never settled and every reload queued behind it.
  it('rejoins even when the previous loop never finishes stopping', async () => {
    const started: string[] = []
    const start = async (opts: StartDaemonOrgSyncOptions): Promise<DaemonOrgSyncHandle | null> => {
      const loaded = await opts.loadCredential!()
      if (!loaded) return null
      started.push(loaded.orgId)
      return {
        state: () => 'live',
        // a loop wedged inside an un-abortable request
        stop: () => new Promise<void>(() => {}),
      }
    }
    await saveOrgCredential(credential('org_a'), home)
    const supervisor = await superviseDaemonOrgSync({
      home, watch: false, start, output: () => {}, stopTimeoutMs: 20,
    })

    await clearOrgCredential(home)
    await supervisor.reload()
    expect(supervisor.state()).toBe('off')

    await saveOrgCredential(credential('org_b'), home)
    await supervisor.reload()

    expect(started).toEqual(['org_a', 'org_b'])
    expect(supervisor.state()).toBe('live')
    await supervisor.stop()
  })

  it('retries after a failed start instead of stranding the daemon offline', async () => {
    const attempts: string[] = []
    let failNext = true
    const start = async (opts: StartDaemonOrgSyncOptions): Promise<DaemonOrgSyncHandle | null> => {
      const loaded = await opts.loadCredential!()
      attempts.push(loaded!.orgId)
      if (failNext) { failNext = false; throw new Error('hub unreachable') }
      return { state: () => 'live', stop: async () => {} }
    }
    const lines: string[] = []
    await saveOrgCredential(credential('org_a'), home)
    const supervisor = await superviseDaemonOrgSync({
      home, watch: false, start, output: (line) => lines.push(line),
    })

    expect(supervisor.state()).toBe('off')
    expect(lines.some((line) => line.includes('could not connect'))).toBe(true)

    // the same credential must be retried — a poisoned fingerprint would no-op here
    await supervisor.reload()
    expect(attempts).toEqual(['org_a', 'org_a'])
    expect(supervisor.state()).toBe('live')
    await supervisor.stop()
  })

  // A cursor that outlives its organization gets applied to the next one, silently
  // skipping that organization's first N events. The daemon owns the clearing because
  // it is the process that was writing them.
  it('clears the cursor and outbox once the loop has stopped on leave', async () => {
    await saveOrgCredential(credential('org_a'), home)
    const rec = recordingStart()
    const supervisor = await superviseDaemonOrgSync({ home, watch: false, start: rec.start, output: () => {} })
    await fs.writeFile(path.join(home, 'org-cursor.json'), JSON.stringify({ seq: 500 }))
    await fs.writeFile(path.join(home, 'outbox.json'), JSON.stringify([{ id: 'op_1' }]))

    await clearOrgCredential(home)
    await supervisor.reload()

    expect(rec.stopped).toEqual(['org_a'])
    await expect(fs.access(path.join(home, 'org-cursor.json'))).rejects.toThrow()
    await expect(fs.access(path.join(home, 'outbox.json'))).rejects.toThrow()
    await supervisor.stop()
  })

  it('stops the loop and the watcher on shutdown', async () => {
    await saveOrgCredential(credential('org_a'), home)
    const rec = recordingStart()
    const supervisor = await superviseDaemonOrgSync({ home, start: rec.start, output: () => {}, debounceMs: 10 })

    await supervisor.stop()
    expect(rec.liveCount()).toBe(0)

    // a write after shutdown must not resurrect the loop
    await saveOrgCredential(credential('org_c'), home)
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(rec.started).toEqual(['org_a'])
  })
})
