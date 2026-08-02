import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'

const TRANSITION_LOCK_FILE = 'state-transition.lock'
const QUIESCENCE_RECEIPT_FILE = 'daemon-quiescence.json'
const DAEMON_PID_FILE = 'daemon.pid'

type DaemonQuiescenceReceipt = {
  format: 'orchestra-daemon-quiescence-v1'
  state_root: string
  database_path: string
  database_device: string
  database_inode: string
  database_bytes: number
  daemon_pid: number
  daemon_lease_owner_id: string
  provider_hooks_inactive: true
  shutdown_completed_at: string
}

export type StateTransitionGuard = {
  lockPath: string
  verify(): void
  release(): void
}

export type DatabaseRestoreQuiescenceGuard = {
  receiptPath: string
  verify(): boolean
  consume(): void
  release(): void
}

const canonicalStateRoot = (stateRoot: string): string => {
  const root = fs.realpathSync(path.resolve(stateRoot))
  if (!fs.statSync(root).isDirectory()) throw new Error('Orchestra state root is not a directory')
  return root
}

const processIsAlive = (pid: number): boolean => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

const stableJson = (value: unknown): string => JSON.stringify(value)
const receiptDigest = (value: string): string => createHash('sha256').update(value).digest('hex')

const assertPrivateRegularFile = (filePath: string, purpose: string): fs.Stats => {
  const stats = fs.lstatSync(filePath)
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error(`${purpose} must be a regular file`)
  if ((stats.mode & 0o077) !== 0) throw new Error(`${purpose} must be owner-only`)
  if (typeof process.getuid === 'function' && stats.uid !== process.getuid()) {
    throw new Error(`${purpose} must be owned by the current operator`)
  }
  return stats
}

/**
 * Serialize daemon startup and database restore before either can claim SQLite authority.
 * A process crash deliberately leaves the owner-only lock for explicit operator inspection.
 */
export function acquireStateTransitionGuard(
  stateRoot: string,
  operation: 'daemon-start' | 'database-restore',
): StateTransitionGuard {
  const root = canonicalStateRoot(stateRoot)
  const lockPath = path.join(root, TRANSITION_LOCK_FILE)
  let descriptor: number
  try {
    descriptor = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error('another daemon startup or database restore owns the state transition lock')
    }
    throw error
  }
  try {
    fs.writeFileSync(descriptor, `${stableJson({
      format: 'orchestra-state-transition-v1',
      operation,
      pid: process.pid,
      created_at: new Date().toISOString(),
    })}\n`)
    fs.fsyncSync(descriptor)
  } catch (error) {
    fs.closeSync(descriptor)
    fs.unlinkSync(lockPath)
    throw error
  }
  const identity = fs.fstatSync(descriptor)
  let released = false
  const verify = (): void => {
    if (released) throw new Error('state transition lock is no longer held')
    let current: fs.Stats
    try { current = fs.lstatSync(lockPath) } catch { throw new Error('state transition lock disappeared while held') }
    if (!current.isFile() || current.isSymbolicLink()
      || current.dev !== identity.dev || current.ino !== identity.ino) {
      throw new Error('state transition lock identity changed while held')
    }
  }
  return {
    lockPath,
    verify,
    release: () => {
      if (released) return
      verify()
      fs.closeSync(descriptor)
      fs.unlinkSync(lockPath)
      released = true
    },
  }
}

/** Invalidate any old clean-shutdown proof before a daemon opens the database. */
export function invalidateDaemonQuiescenceReceipt(stateRoot: string): void {
  const receiptPath = path.join(canonicalStateRoot(stateRoot), QUIESCENCE_RECEIPT_FILE)
  try {
    const stats = fs.lstatSync(receiptPath)
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error('daemon quiescence receipt path is not a regular file')
    }
    fs.unlinkSync(receiptPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

const assertNoDaemonLease = (databasePath: string): void => {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true })
  try {
    const table = db.prepare(`SELECT 1 AS present FROM sqlite_master
      WHERE type='table' AND name='daemon_leases'`).get() as { present: number } | undefined
    if (table?.present !== 1) throw new Error('database cannot prove daemon lease state')
    const active = db.prepare('SELECT owner_id, pid FROM daemon_leases ORDER BY name LIMIT 1')
      .get() as { owner_id: string; pid: number } | undefined
    if (active) throw new Error(`database daemon authority is still recorded for pid ${active.pid}`)
  } finally {
    db.close()
  }
}

/**
 * Record proof only after provider runtimes/hooks are inactive, the daemon lease is released,
 * and SQLite is closed. The CLI separately proves this recorded PID has exited.
 */
export function writeDaemonQuiescenceReceipt(input: {
  stateRoot: string
  databasePath: string
  daemonPid: number
  daemonLeaseOwnerId: string
  providerHooksInactive: boolean
  now?: Date
}): string {
  const stateRoot = canonicalStateRoot(input.stateRoot)
  const databasePath = fs.realpathSync(path.resolve(input.databasePath))
  if (path.dirname(databasePath) !== stateRoot) throw new Error('daemon database is not bound to the state root')
  if (input.daemonPid !== process.pid) throw new Error('quiescence receipt PID is not the recording daemon')
  if (!input.providerHooksInactive) throw new Error('provider-hook inactivity was not proven')
  if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(input.daemonLeaseOwnerId)) {
    throw new Error('daemon lease owner identity is invalid')
  }
  assertNoDaemonLease(databasePath)
  const database = fs.statSync(databasePath)
  const receipt: DaemonQuiescenceReceipt = {
    format: 'orchestra-daemon-quiescence-v1',
    state_root: stateRoot,
    database_path: databasePath,
    database_device: String(database.dev),
    database_inode: String(database.ino),
    database_bytes: database.size,
    daemon_pid: input.daemonPid,
    daemon_lease_owner_id: input.daemonLeaseOwnerId,
    provider_hooks_inactive: true,
    shutdown_completed_at: (input.now ?? new Date()).toISOString(),
  }
  const receiptPath = path.join(stateRoot, QUIESCENCE_RECEIPT_FILE)
  const partialPath = path.join(stateRoot, `.${QUIESCENCE_RECEIPT_FILE}.${process.pid}.${randomUUID()}.partial`)
  try {
    fs.writeFileSync(partialPath, `${stableJson(receipt)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    const descriptor = fs.openSync(partialPath, fs.constants.O_RDONLY)
    try { fs.fsyncSync(descriptor) } finally { fs.closeSync(descriptor) }
    fs.renameSync(partialPath, receiptPath)
  } catch (error) {
    try { fs.unlinkSync(partialPath) } catch { /* retain the original failure */ }
    throw error
  }
  return receiptPath
}

const readAndVerifyReceipt = (
  stateRoot: string,
  destinationPath: string,
  expectedDigest?: string,
): { path: string; digest: string } => {
  const receiptPath = path.join(stateRoot, QUIESCENCE_RECEIPT_FILE)
  try {
    assertPrivateRegularFile(receiptPath, 'daemon quiescence receipt')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('daemon quiescence receipt is missing; clean shutdown is unproven')
    }
    throw error
  }
  const raw = fs.readFileSync(receiptPath, 'utf8')
  const digest = receiptDigest(raw)
  if (expectedDigest && digest !== expectedDigest) throw new Error('daemon quiescence receipt changed during restore')
  let receipt: DaemonQuiescenceReceipt
  try { receipt = JSON.parse(raw) as DaemonQuiescenceReceipt } catch { throw new Error('daemon quiescence receipt is invalid') }
  const keys = Object.keys(receipt as unknown as Record<string, unknown>).sort()
  const expectedKeys = [
    'daemon_lease_owner_id', 'daemon_pid', 'database_bytes', 'database_device', 'database_inode',
    'database_path', 'format', 'provider_hooks_inactive', 'shutdown_completed_at', 'state_root',
  ].sort()
  if (stableJson(keys) !== stableJson(expectedKeys)
    || receipt.format !== 'orchestra-daemon-quiescence-v1'
    || receipt.state_root !== stateRoot
    || receipt.database_path !== destinationPath
    || receipt.provider_hooks_inactive !== true
    || !Number.isSafeInteger(receipt.daemon_pid)
    || receipt.daemon_pid <= 0
    || !Number.isFinite(Date.parse(receipt.shutdown_completed_at))
    || !/^[A-Za-z0-9._:-]{1,128}$/u.test(receipt.daemon_lease_owner_id)) {
    throw new Error('daemon quiescence receipt does not match this restore')
  }
  if (processIsAlive(receipt.daemon_pid)) throw new Error('recorded daemon PID is still active')
  const database = fs.statSync(destinationPath)
  if (String(database.dev) !== receipt.database_device
    || String(database.ino) !== receipt.database_inode
    || database.size !== receipt.database_bytes) {
    throw new Error('database identity changed after daemon shutdown')
  }
  const pidPath = path.join(stateRoot, DAEMON_PID_FILE)
  try {
    assertPrivateRegularFile(pidPath, 'daemon PID file')
    throw new Error('daemon PID file still exists; shutdown completion is unproven')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  assertNoDaemonLease(destinationPath)
  return { path: receiptPath, digest }
}

/** Acquire a fail-closed, state-bound proof that remains serialized through database replacement. */
export function acquireDatabaseRestoreQuiescenceGuard(input: {
  stateRoot: string
  destinationPath: string
}): DatabaseRestoreQuiescenceGuard {
  const stateRoot = canonicalStateRoot(input.stateRoot)
  const destinationPath = fs.realpathSync(path.resolve(input.destinationPath))
  if (path.dirname(destinationPath) !== stateRoot) throw new Error('restore destination is not bound to the state root')
  const transition = acquireStateTransitionGuard(stateRoot, 'database-restore')
  try {
    const initial = readAndVerifyReceipt(stateRoot, destinationPath)
    let consumed = false
    return {
      receiptPath: initial.path,
      verify: () => {
        if (consumed) return false
        transition.verify()
        readAndVerifyReceipt(stateRoot, destinationPath, initial.digest)
        return true
      },
      consume: () => {
        if (consumed) return
        const current = fs.readFileSync(initial.path, 'utf8')
        if (receiptDigest(current) !== initial.digest) throw new Error('daemon quiescence receipt changed during restore')
        fs.unlinkSync(initial.path)
        consumed = true
      },
      release: transition.release,
    }
  } catch (error) {
    transition.release()
    throw error
  }
}
