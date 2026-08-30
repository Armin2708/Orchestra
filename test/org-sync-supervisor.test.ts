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
