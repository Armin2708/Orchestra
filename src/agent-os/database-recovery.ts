import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import Database from 'better-sqlite3'

const executeFile = promisify(execFile)

export type DatabaseBackupManifest = {
  format: 'orchestra-sqlite-backup-v1'
  created_at: string
  database_file: string
  database_bytes: number
  database_sha256: string
  schema_sha256: string
  migrations: Array<{ id: string; applied_at: string }>
  migrations_sha256: string
}

export type VerifiedDatabaseBackup = {
  manifestPath: string
  databasePath: string
  manifest: DatabaseBackupManifest
}

export type RepositoryExecutionTarget = {
  repositoryRoot: string
  workspaceRoot: string
  cwd: string
  branch: string | null
}

const stableJson = (value: unknown): string => JSON.stringify(sortJson(value))
const sortJson = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortJson)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortJson(item)]))
  }
  return value
}
const digest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
const isWithin = (parent: string, child: string, allowRoot = false): boolean => {
  const relative = path.relative(parent, child)
  if (relative === '') return allowRoot
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}
const safeBasename = (value: string): string => {
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/iu.test(value) || value === '.' || value === '..') {
    throw new Error('backup name is invalid')
  }
  return value
}

async function fileSha256(file: string): Promise<string> {
  const handle = await open(file, 'r')
  try {
    const hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(1024 * 1024)
    let offset = 0
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)
      if (bytesRead === 0) break
      hash.update(buffer.subarray(0, bytesRead))
      offset += bytesRead
    }
    return hash.digest('hex')
  } finally {
    await handle.close()
  }
}

/** Resolve a path without permitting lexical escape or traversal through a symlink. */
export async function assertSafeChildPath(
  allowedRoot: string,
  candidate: string,
  options: { allowRoot?: boolean; mustExist?: boolean } = {},
): Promise<string> {
  const requestedRoot = path.resolve(allowedRoot)
  const requestedCandidate = path.resolve(candidate)
  if (!isWithin(requestedRoot, requestedCandidate, options.allowRoot ?? false)) {
    throw new Error('path resolves outside the allowed root')
  }
  const canonicalRoot = await realpath(requestedRoot)
  const resolved = path.resolve(canonicalRoot, path.relative(requestedRoot, requestedCandidate))
  const relative = path.relative(canonicalRoot, resolved)
  let cursor = canonicalRoot
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment)
    try {
      if ((await lstat(cursor)).isSymbolicLink()) throw new Error('path cannot traverse a symlink')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break
      throw error
    }
  }
  if (options.mustExist) return realpath(resolved)
  return resolved
}

/**
 * Validate the repository/worktree/cwd tuple using argv-only Git calls. A worktree must be
 * registered by its repository and cwd must remain inside that exact execution root.
 */
export async function assertRepositoryExecutionTarget(input: {
  repositoryRoot: string
  workspaceRoot: string
  cwd: string
  expectedBranch?: string | null
}): Promise<RepositoryExecutionTarget> {
  const requestedRepository = await realpath(path.resolve(input.repositoryRoot))
  const { stdout: topLevel } = await executeFile('git', ['rev-parse', '--show-toplevel'], {
    cwd: requestedRepository,
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  })
  const repositoryRoot = await realpath(topLevel.trim())
  if (repositoryRoot !== requestedRepository) throw new Error('repository root does not match the requested root')
  const workspaceRoot = await realpath(path.resolve(input.workspaceRoot))
  const cwd = await realpath(path.resolve(input.cwd))
  if (!isWithin(workspaceRoot, cwd, true)) throw new Error('cwd resolves outside the workspace root')

  const { stdout: worktreeOutput } = await executeFile('git', ['worktree', 'list', '--porcelain'], {
    cwd: repositoryRoot,
    timeout: 30_000,
    maxBuffer: 16 * 1024 * 1024,
  })
  const registered = parseWorktrees(worktreeOutput).find((item) => path.resolve(item.path) === workspaceRoot)
  if (!registered) throw new Error('workspace is not a registered repository worktree')
  if (input.expectedBranch !== undefined && input.expectedBranch !== registered.branch) {
    throw new Error('registered worktree branch does not match the durable workspace branch')
  }
  return { repositoryRoot, workspaceRoot, cwd, branch: registered.branch }
}

/** Make a consistent SQLite online backup, then verify integrity before publishing its manifest. */
export async function createDatabaseBackup(
  db: Database.Database,
  input: { backupRoot: string; name?: string; now?: Date },
): Promise<VerifiedDatabaseBackup> {
  const backupRoot = await realpath(path.resolve(input.backupRoot))
  const now = input.now ?? new Date()
  const name = safeBasename(input.name ?? `orchestra-${now.toISOString().replace(/[:.]/gu, '-')}`)
  const databasePath = await assertSafeChildPath(backupRoot, path.join(backupRoot, `${name}.sqlite`))
  const manifestPath = await assertSafeChildPath(backupRoot, path.join(backupRoot, `${name}.manifest.json`))
  const partialDatabase = await assertSafeChildPath(backupRoot, `${databasePath}.partial`)
  const partialManifest = await assertSafeChildPath(backupRoot, `${manifestPath}.partial`)
  for (const target of [databasePath, manifestPath, partialDatabase, partialManifest]) {
    try {
      await lstat(target)
      throw new Error(`backup target already exists: ${path.basename(target)}`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  try {
    await db.backup(partialDatabase)
    const verified = inspectDatabase(partialDatabase)
    const databaseBytes = (await stat(partialDatabase)).size
    const manifest: DatabaseBackupManifest = {
      format: 'orchestra-sqlite-backup-v1',
      created_at: now.toISOString(),
      database_file: path.basename(databasePath),
      database_bytes: databaseBytes,
      database_sha256: await fileSha256(partialDatabase),
      schema_sha256: verified.schemaSha256,
      migrations: verified.migrations,
      migrations_sha256: digest(stableJson(verified.migrations)),
    }
    await writeFile(partialManifest, `${stableJson(manifest)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    await rename(partialDatabase, databasePath)
    await rename(partialManifest, manifestPath)
    return { manifestPath, databasePath, manifest }
  } catch (error) {
    await unlink(partialDatabase).catch(() => undefined)
    await unlink(partialManifest).catch(() => undefined)
    throw error
  }
}

/** Verify checksum, byte size, migration inventory, schema hash, integrity, and foreign keys. */
export async function verifyDatabaseBackup(manifestPath: string): Promise<VerifiedDatabaseBackup> {
  const resolvedManifest = await realpath(path.resolve(manifestPath))
  const manifest = JSON.parse(await readFile(resolvedManifest, 'utf8')) as DatabaseBackupManifest
  validateManifest(manifest)
  const databasePath = await assertSafeChildPath(
    path.dirname(resolvedManifest),
    path.join(path.dirname(resolvedManifest), manifest.database_file),
    { mustExist: true },
  )
  const databaseStats = await stat(databasePath)
  if (databaseStats.size !== manifest.database_bytes) throw new Error('backup byte size does not match its manifest')
  if (await fileSha256(databasePath) !== manifest.database_sha256) throw new Error('backup checksum does not match its manifest')
  const inspected = inspectDatabase(databasePath)
  if (inspected.schemaSha256 !== manifest.schema_sha256) throw new Error('backup schema checksum does not match its manifest')
  if (digest(stableJson(inspected.migrations)) !== manifest.migrations_sha256
    || stableJson(inspected.migrations) !== stableJson(manifest.migrations)) {
    throw new Error('backup migration inventory does not match its manifest')
  }
  return { manifestPath: resolvedManifest, databasePath, manifest }
}

/**
 * Restore only while the caller proves the daemon is quiesced. Existing state is moved into a
 * quarantine directory; it is never deleted or silently overwritten.
 */
export async function restoreDatabaseBackup(input: {
  manifestPath: string
  stateRoot: string
  destinationPath: string
  isQuiesced: () => boolean | Promise<boolean>
  now?: Date
}): Promise<{ destinationPath: string; quarantinePath: string | null }> {
  if (!(await input.isQuiesced())) throw new Error('database restore requires a quiesced daemon and provider hooks')
  const requestedStateRoot = path.resolve(input.stateRoot)
  const stateRoot = await realpath(requestedStateRoot)
  const destinationPath = await assertSafeChildPath(requestedStateRoot, input.destinationPath)
  const backup = await verifyDatabaseBackup(input.manifestPath)
  const partial = await assertSafeChildPath(stateRoot, `${destinationPath}.restore-partial`)
  try {
    await lstat(partial)
    throw new Error('stale restore partial exists; inspect it before retrying')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  await copyFile(backup.databasePath, partial)
  if (await fileSha256(partial) !== backup.manifest.database_sha256) {
    await unlink(partial).catch(() => undefined)
    throw new Error('backup changed while it was being copied for restore')
  }
  inspectDatabase(partial)

  let quarantinePath: string | null = null
  try {
    try {
      await lstat(destinationPath)
      const stamp = (input.now ?? new Date()).toISOString().replace(/[:.]/gu, '-')
      const quarantineRoot = await assertSafeChildPath(stateRoot, path.join(stateRoot, 'quarantine'))
      await mkdir(quarantineRoot, { recursive: true, mode: 0o700 })
      quarantinePath = await assertSafeChildPath(
        quarantineRoot,
        path.join(quarantineRoot, `${path.basename(destinationPath)}.${stamp}`),
      )
      await rename(destinationPath, quarantinePath)
      for (const suffix of ['-wal', '-shm']) {
        const companion = `${destinationPath}${suffix}`
        try {
          await rename(companion, `${quarantinePath}${suffix}`)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await rename(partial, destinationPath)
    inspectDatabase(destinationPath)
    return { destinationPath, quarantinePath }
  } catch (error) {
    await unlink(partial).catch(() => undefined)
    if (quarantinePath) {
      try {
        await lstat(destinationPath)
        const failed = await assertSafeChildPath(
          stateRoot,
          `${destinationPath}.failed-restore-${(input.now ?? new Date()).toISOString().replace(/[:.]/gu, '-')}`,
        )
        await rename(destinationPath, failed)
      } catch (missing) {
        if ((missing as NodeJS.ErrnoException).code !== 'ENOENT') throw missing
      }
      await rename(quarantinePath, destinationPath)
      for (const suffix of ['-wal', '-shm']) {
        try {
          await rename(`${quarantinePath}${suffix}`, `${destinationPath}${suffix}`)
        } catch (companionError) {
          if ((companionError as NodeJS.ErrnoException).code !== 'ENOENT') throw companionError
        }
      }
    }
    throw error
  }
}

/** Move expired/surplus backups into a recoverable retired directory instead of deleting them. */
export async function retireDatabaseBackups(input: {
  backupRoot: string
  keep: number
  olderThan?: Date
}): Promise<string[]> {
  if (!Number.isSafeInteger(input.keep) || input.keep < 1) throw new Error('backup retention keep must be positive')
  const root = await realpath(path.resolve(input.backupRoot))
  const manifests = await Promise.all((await readdir(root))
    .filter((name) => name.endsWith('.manifest.json'))
    .map(async (name) => {
      const manifest = JSON.parse(await readFile(path.join(root, name), 'utf8')) as DatabaseBackupManifest
      validateManifest(manifest)
      return { name, manifest }
    }))
  manifests.sort((left, right) => Date.parse(right.manifest.created_at) - Date.parse(left.manifest.created_at)
    || left.name.localeCompare(right.name))
  const retire = manifests.filter((entry, index) => {
    if (index >= input.keep) return true
    if (!input.olderThan) return false
    return false
  })
  if (input.olderThan) {
    for (const entry of manifests.slice(0, input.keep)) {
      if (Date.parse(entry.manifest.created_at) < input.olderThan.getTime() && !retire.includes(entry)) retire.push(entry)
    }
  }
  if (!retire.length) return []
  const retiredRoot = path.join(root, 'retired')
  await mkdir(retiredRoot, { recursive: true, mode: 0o700 })
  const retired: string[] = []
  for (const { name } of retire.sort((left, right) => left.name.localeCompare(right.name))) {
    const manifestPath = await assertSafeChildPath(root, path.join(root, name), { mustExist: true })
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as DatabaseBackupManifest
    validateManifest(manifest)
    const databasePath = await assertSafeChildPath(root, path.join(root, manifest.database_file), { mustExist: true })
    const targetManifest = await assertSafeChildPath(retiredRoot, path.join(retiredRoot, name))
    const targetDatabase = await assertSafeChildPath(retiredRoot, path.join(retiredRoot, manifest.database_file))
    await rename(databasePath, targetDatabase)
    await rename(manifestPath, targetManifest)
    retired.push(name)
  }
  return retired
}

function inspectDatabase(databasePath: string): {
  schemaSha256: string
  migrations: Array<{ id: string; applied_at: string }>
} {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true })
  try {
    const integrity = db.pragma('integrity_check') as Array<{ integrity_check: string }>
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') throw new Error('database integrity check failed')
    const foreignKeys = db.pragma('foreign_key_check') as unknown[]
    if (foreignKeys.length) throw new Error('database foreign-key check failed')
    const schema = db.prepare(`SELECT type, name, tbl_name, coalesce(sql, '') AS sql
      FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'
      ORDER BY type, name`).all() as Array<Record<string, unknown>>
    const hasMigrations = db.prepare(`SELECT 1 FROM sqlite_master
      WHERE type='table' AND name='os_schema_migrations'`).get()
    const migrations = hasMigrations
      ? db.prepare(`SELECT id, applied_at FROM os_schema_migrations ORDER BY rowid`).all() as Array<{
          id: string
          applied_at: string
        }>
      : []
    return { schemaSha256: digest(stableJson(schema)), migrations }
  } finally {
    db.close()
  }
}

function validateManifest(manifest: DatabaseBackupManifest): void {
  if (manifest.format !== 'orchestra-sqlite-backup-v1') throw new Error('unsupported backup manifest format')
  safeBasename(manifest.database_file)
  if (!Number.isSafeInteger(manifest.database_bytes) || manifest.database_bytes < 1) throw new Error('invalid backup byte size')
  for (const value of [manifest.database_sha256, manifest.schema_sha256, manifest.migrations_sha256]) {
    if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error('invalid backup checksum')
  }
  if (Number.isNaN(Date.parse(manifest.created_at)) || !Array.isArray(manifest.migrations)) {
    throw new Error('invalid backup manifest metadata')
  }
}

function parseWorktrees(output: string): Array<{ path: string; branch: string | null }> {
  const result: Array<{ path: string; branch: string | null }> = []
  let current: { path: string; branch: string | null } | undefined
  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current) result.push(current)
      current = { path: path.resolve(line.slice('worktree '.length)), branch: null }
    } else if (current && line.startsWith('branch refs/heads/')) {
      current.branch = line.slice('branch refs/heads/'.length)
    }
  }
  if (current) result.push(current)
  return result
}
