import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  startDaemonOrgSync,
  type DaemonOrgSyncHandle,
  type StartDaemonOrgSyncOptions,
} from './daemon-integration.js'
import { loadOrgCredential, type OrgCredential } from './credentials.js'
import { clearOrgSyncState } from './state.js'
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
  /** Why sync is in its current state, when the hub gave a reason. */
  detail(): string | null
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
  /** How long to wait for a loop to stop before abandoning it and continuing. */
  stopTimeoutMs?: number
}

// Never let a hub URL, an org id, or anything else from a credential reach a log line.
const safeMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))

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

  // A stuck loop must not take the supervisor with it. Reloads are serialised, so an
  // awaited stop() that never settles would leave every later join queued behind it
  // forever — the daemon would disconnect on `org leave` and never come back.
  const stopHandle = async (target: DaemonOrgSyncHandle): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        target.stop(),
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            output('org-sync did not stop within 10s; abandoning the old loop and continuing')
            resolve()
          }, options.stopTimeoutMs ?? 10_000)
          timer.unref?.()
        }),
      ])
    } catch (error) {
      output(`org-sync could not stop cleanly: ${safeMessage(error)}`)
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  const applyCredential = async (): Promise<void> => {
    if (stopped) return
    const credential = await load().catch(() => null)
    const next = fingerprint(credential)
    if (next === current) return
    // Claim the new fingerprint up front so concurrent events coalesce, but drop the
    // claim on any failure below — a poisoned fingerprint would make every later
    // reload a no-op and strand the daemon offline.
    current = next
    currentOrgId = credential?.orgId ?? null
    try {
      if (handle) {
        const previous = handle
        handle = null
        await stopHandle(previous)
        if (!credential) {
          // Clear the cursor and outbox here, not in the CLI: this is the process that
          // owns the loop, so by now nothing can still be writing them. A cursor that
          // outlives its organization gets applied to the next one, silently skipping
          // that organization's first N events.
          await clearOrgSyncState(home).catch((error) =>
            output(`org-sync could not clear local sync state: ${safeMessage(error)}`))
          output('org-sync off (left the organization)')
        }
      }
      if (!credential) {
        // Only the boot-time "nothing joined" line is worth printing; later no-ops are silent.
        if (!announcedOff) { output('org-sync off (no organization joined)'); announcedOff = true }
        return
      }
      announcedOff = true
      handle = await start({ ...options, home, output, loadCredential: async () => credential })
      if (!handle) current = null
    } catch (error) {
      current = null
      currentOrgId = null
      output(`org-sync could not connect: ${safeMessage(error)}; it will retry on the next credential change`)
    }
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
    detail: () => handle?.detail() ?? null,
    reload,
    stop: async () => {
      stopped = true
      if (debounce) clearTimeout(debounce)
      watcher?.close()
      watcher = undefined
      await queue.catch(() => undefined)
      if (handle) {
        const previous = handle
        handle = null
        await stopHandle(previous)
      }
    },
  }
}
