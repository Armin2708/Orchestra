import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  startDaemonOrgSync,
  type DaemonOrgSyncHandle,
  type StartDaemonOrgSyncOptions,
} from './daemon-integration.js'
import { loadOrgCredential, type OrgCredential } from './credentials.js'
import type { SyncState } from './sync-loop.js'

// `orchestra org join` writes the credential and exits; the daemon that has to act on it
// is a different process, already running. Reading the credential once at boot meant
// joining an organization only took effect after a daemon restart — which drops every
// hired agent, for a change that has nothing to do with them. The supervisor watches the
// credential instead, so join and leave take effect on a running daemon.

const CREDENTIAL_FILE = 'org.json'

export type SupervisedSyncState = SyncState | 'off'

export interface DaemonOrgSyncSupervisor {
  /** The running loop's state, or 'off' when no organization is joined. */
  state(): SupervisedSyncState
  /** The joined organization, or null. */
  orgId(): string | null
  /** Re-read the credential and start, stop, or switch the sync loop to match it. */
  reload(): Promise<void>
  stop(): Promise<void>
}

export interface SuperviseDaemonOrgSyncOptions extends StartDaemonOrgSyncOptions {
  /** Watch the credential file for changes. Off in tests that drive reload() directly. */
  watch?: boolean
  /** Seam for tests. */
  start?: (options: StartDaemonOrgSyncOptions) => Promise<DaemonOrgSyncHandle | null>
  /** Coalescing window for filesystem events; the credential is written temp-file-then-rename. */
  debounceMs?: number
}

// Restart only when the credential actually differs — a rewrite with identical contents
// must not interrupt a healthy loop.
const fingerprint = (credential: OrgCredential | null): string | null => credential && JSON.stringify([
  credential.hubBaseUrl, credential.orgId, credential.deviceToken, credential.deviceName,
])

export async function superviseDaemonOrgSync(
  options: SuperviseDaemonOrgSyncOptions = {},
): Promise<DaemonOrgSyncSupervisor> {
  const home = options.home ?? process.env.ORCHESTRA_HOME ?? path.join(os.homedir(), '.orchestra')
  const output = options.output ?? console.log
  const start = options.start ?? startDaemonOrgSync
  const load = options.loadCredential ?? (() => loadOrgCredential(home))

  let handle: DaemonOrgSyncHandle | null = null
  let current: string | null = null
  let currentOrgId: string | null = null
  let announcedOff = false
  let stopped = false
  let watcher: fs.FSWatcher | undefined
  let debounce: ReturnType<typeof setTimeout> | undefined
  // Reloads are serialised: a rename storm must never run two starts concurrently.
  let queue: Promise<void> = Promise.resolve()

  const applyCredential = async (): Promise<void> => {
    if (stopped) return
    const credential = await load().catch(() => null)
    const next = fingerprint(credential)
    if (next === current) return
    if (handle) {
      await handle.stop().catch((error) => output(`org-sync could not stop cleanly: ${String(error)}`))
      handle = null
      if (!credential) output('org-sync off (left the organization)')
    }
    current = next
    currentOrgId = credential?.orgId ?? null
    if (!credential) {
      // Only the boot-time "nothing joined" line is worth printing; later no-ops are silent.
      if (!announcedOff) { output('org-sync off (no organization joined)'); announcedOff = true }
      return
    }
    announcedOff = true
    handle = await start({ ...options, home, output, loadCredential: async () => credential })
    if (!handle) current = null
  }

  const reload = (): Promise<void> => {
    queue = queue.then(applyCredential, applyCredential)
    return queue
  }

  await reload()

  if (options.watch !== false) {
    try {
      fs.mkdirSync(home, { recursive: true, mode: 0o700 })
      // Watch the directory, not the file: the credential is saved by renaming a temp file
      // over it, which replaces the inode a file watch would still be holding.
      watcher = fs.watch(home, (_event, filename) => {
        if (filename && filename !== CREDENTIAL_FILE) return
        if (debounce) clearTimeout(debounce)
        debounce = setTimeout(() => { void reload() }, options.debounceMs ?? 150)
        debounce.unref?.()
      })
      watcher.unref?.()
      watcher.on('error', (error) => output(`org-sync stopped watching for credential changes: ${String(error)}`))
    } catch (error) {
      // A daemon that cannot watch still syncs; it just needs a restart to notice a join.
      output(`org-sync could not watch for credential changes: ${String(error)}`)
    }
  }

  return {
    state: () => handle?.state() ?? 'off',
    orgId: () => currentOrgId,
    reload,
    stop: async () => {
      stopped = true
      if (debounce) clearTimeout(debounce)
      watcher?.close()
      watcher = undefined
      await queue.catch(() => undefined)
      await handle?.stop()
      handle = null
    },
  }
}
