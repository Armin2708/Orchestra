import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { openDb } from '../src/db.js'
import {
  assertRepositoryExecutionTarget,
  assertSafeChildPath,
  createDatabaseBackup,
  restoreDatabaseBackup,
  retireDatabaseBackups,
  verifyDatabaseBackup,
} from '../src/agent-os/database-recovery.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('OPS checksummed SQLite backup and restore', () => {
  it('creates a consistent online backup with schema/migration checksums and restores offline', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-database-recovery-'))
    roots.push(root)
    const backupRoot = path.join(root, 'backups')
    fs.mkdirSync(backupRoot)
    const databasePath = path.join(root, 'orchestra.db')
    const db = openDb(databasePath)
    db.prepare("INSERT INTO boards (project_path, name) VALUES ('/before', 'before')").run()
    const backup = await createDatabaseBackup(db, {
      backupRoot,
      name: 'known-good',
      now: new Date('2026-08-02T08:00:00.000Z'),
    })
    db.prepare("INSERT INTO boards (project_path, name) VALUES ('/after', 'after')").run()
    db.close()

    const verified = await verifyDatabaseBackup(backup.manifestPath)
    expect(verified.manifest).toMatchObject({
      format: 'orchestra-sqlite-backup-v1',
      database_file: 'known-good.sqlite',
      created_at: '2026-08-02T08:00:00.000Z',
    })
    expect(verified.manifest.database_sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(verified.manifest.schema_sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(verified.manifest.migrations.length).toBeGreaterThan(20)

    await expect(restoreDatabaseBackup({
      manifestPath: backup.manifestPath,
      stateRoot: root,
      destinationPath: databasePath,
      isQuiesced: async () => false,
    })).rejects.toThrow(/quiesced/)
    const restored = await restoreDatabaseBackup({
      manifestPath: backup.manifestPath,
      stateRoot: root,
      destinationPath: databasePath,
      isQuiesced: async () => true,
      now: new Date('2026-08-02T08:05:00.000Z'),
    })
    expect(restored.quarantinePath).toContain(`${path.sep}quarantine${path.sep}`)
    expect(fs.existsSync(restored.quarantinePath!)).toBe(true)
    const reopened = openDb(databasePath)
    expect(reopened.prepare('SELECT name FROM boards ORDER BY id').all()).toEqual([{ name: 'before' }])
    reopened.close()
  })

  it('rejects corrupted bytes and a manifest redirected outside its backup directory', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-database-corrupt-'))
    roots.push(root)
    const backupRoot = path.join(root, 'backups')
    fs.mkdirSync(backupRoot)
    const db = openDb(path.join(root, 'orchestra.db'))
    const backup = await createDatabaseBackup(db, { backupRoot, name: 'corrupt-me' })
    db.close()
    fs.appendFileSync(backup.databasePath, 'corruption')
    await expect(verifyDatabaseBackup(backup.manifestPath)).rejects.toThrow(/byte size|checksum/)

    const escaped = JSON.parse(fs.readFileSync(backup.manifestPath, 'utf8'))
    escaped.database_file = '../orchestra.db'
    fs.writeFileSync(backup.manifestPath, JSON.stringify(escaped))
    await expect(verifyDatabaseBackup(backup.manifestPath)).rejects.toThrow(/backup name|outside/)
  })

  it('retires surplus backups recoverably instead of deleting them', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-database-retention-'))
    roots.push(root)
    const backupRoot = path.join(root, 'backups')
    fs.mkdirSync(backupRoot)
    const db = openDb(path.join(root, 'orchestra.db'))
    await createDatabaseBackup(db, {
      backupRoot, name: 'backup-a', now: new Date('2026-08-01T08:00:00.000Z'),
    })
    await createDatabaseBackup(db, {
      backupRoot, name: 'backup-b', now: new Date('2026-08-02T08:00:00.000Z'),
    })
    db.close()
    await expect(retireDatabaseBackups({ backupRoot, keep: 1 }))
      .resolves.toEqual(['backup-a.manifest.json'])
    expect(fs.existsSync(path.join(backupRoot, 'retired', 'backup-a.sqlite'))).toBe(true)
    expect(fs.existsSync(path.join(backupRoot, 'backup-b.sqlite'))).toBe(true)
  })
})

describe('OPS repository and path safety', () => {
  it('accepts only the registered worktree/branch/cwd tuple and rejects escape paths', async () => {
    // hermetic scratch repo — the project checkout may be a detached HEAD (CI) or a
    // linked worktree, neither of which this contract is about
    const repositoryRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-exec-target-')))
    roots.push(repositoryRoot)
    const { execFileSync } = await import('node:child_process')
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repositoryRoot })
    execFileSync('git', ['-c', 'user.email=ci@test', '-c', 'user.name=ci',
      'commit', '--allow-empty', '-q', '-m', 'seed'], { cwd: repositoryRoot })
    fs.mkdirSync(path.join(repositoryRoot, 'src'))
    const currentBranch = 'main'
    await expect(assertRepositoryExecutionTarget({
      repositoryRoot,
      workspaceRoot: repositoryRoot,
      cwd: path.join(repositoryRoot, 'src'),
      expectedBranch: currentBranch,
    })).resolves.toMatchObject({
      repositoryRoot,
      workspaceRoot: repositoryRoot,
      branch: currentBranch,
    })
    await expect(assertRepositoryExecutionTarget({
      repositoryRoot,
      workspaceRoot: repositoryRoot,
      cwd: os.tmpdir(),
      expectedBranch: currentBranch,
    })).rejects.toThrow(/outside/)
  })

  it('rejects lexical and symlink escape beneath an allowed root', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-safe-path-'))
    roots.push(root)
    fs.symlinkSync(os.tmpdir(), path.join(root, 'linked'))
    await expect(assertSafeChildPath(root, path.join(root, '..', 'escape'))).rejects.toThrow(/outside/)
    await expect(assertSafeChildPath(root, path.join(root, 'linked', 'escape'))).rejects.toThrow(/symlink|outside/)
  })

  it.each(['backup', 'retire-backups'])('rejects ops %s when --root is a symlink outside state', (command) => {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-ops-cli-state-'))
    const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-ops-cli-external-'))
    roots.push(stateRoot, externalRoot)
    const linkedRoot = path.join(stateRoot, 'backups-link')
    fs.symlinkSync(externalRoot, linkedRoot)
    const args = command === 'backup'
      ? ['ops', 'backup', 'blocked', '--root', linkedRoot]
      : ['ops', 'retire-backups', '--root', linkedRoot, '--keep', '1']
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 10_000,
      env: { ...process.env, ORCHESTRA_HOME: stateRoot },
    })
    expect(result.status).not.toBe(0)
    expect(`${result.stdout}${result.stderr}`).toMatch(/symlink|outside Orchestra state/u)
    expect(fs.readdirSync(externalRoot)).toEqual([])
  })
})
