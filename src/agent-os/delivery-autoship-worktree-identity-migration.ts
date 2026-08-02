import type Database from 'better-sqlite3'

export const AGENT_OS_DELIVERY_AUTOSHIP_WORKTREE_IDENTITY_MIGRATION_ID =
  '038-delivery-autoship-worktree-identity'

export const DELIVERY_AUTOSHIP_WORKTREE_IDENTITY_COLUMNS = Object.freeze([
  'worktree_path',
  'worktree_git_dir',
  'worktree_common_dir',
  'worktree_git_dir_device',
  'worktree_git_dir_inode',
] as const)

const IDENTITY_TRIGGER = 'delivery_autoship_intents_worktree_identity'

/**
 * Adds durable linked-worktree identity to the immutable autoship outbox.
 * Existing 037 rows remain nullable and therefore fail closed during completion;
 * every new intent is required to bind all five fields.
 */
export function installDeliveryAutoshipWorktreeIdentitySchema(db: Database.Database): void {
  const table = db.prepare(`SELECT 1 FROM sqlite_master
    WHERE type='table' AND name='delivery_autoship_intents'`).get()
  if (!table) {
    throw new Error(
      `migration ${AGENT_OS_DELIVERY_AUTOSHIP_WORKTREE_IDENTITY_MIGRATION_ID}`
      + ' requires delivery_autoship_intents',
    )
  }
  const columns = new Set((db.prepare(`PRAGMA table_info('delivery_autoship_intents')`)
    .all() as Array<{ name: string }>).map((column) => column.name))
  for (const column of DELIVERY_AUTOSHIP_WORKTREE_IDENTITY_COLUMNS) {
    if (!columns.has(column)) {
      db.exec(`ALTER TABLE delivery_autoship_intents ADD COLUMN ${column} TEXT`)
    }
  }
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS ${IDENTITY_TRIGGER}
    BEFORE INSERT ON delivery_autoship_intents
    WHEN NEW.worktree_path IS NULL OR length(NEW.worktree_path)=0
      OR NEW.worktree_git_dir IS NULL OR length(NEW.worktree_git_dir)=0
      OR NEW.worktree_common_dir IS NULL OR length(NEW.worktree_common_dir)=0
      OR NEW.worktree_git_dir_device IS NULL OR length(NEW.worktree_git_dir_device)=0
      OR NEW.worktree_git_dir_inode IS NULL OR length(NEW.worktree_git_dir_inode)=0
    BEGIN
      SELECT RAISE(ABORT, 'delivery autoship worktree identity is required');
    END;
  `)
  assertDeliveryAutoshipWorktreeIdentitySchema(db)
}

export function assertDeliveryAutoshipWorktreeIdentitySchema(db: Database.Database): void {
  const columns = new Set((db.prepare(`PRAGMA table_info('delivery_autoship_intents')`)
    .all() as Array<{ name: string }>).map((column) => column.name))
  for (const column of DELIVERY_AUTOSHIP_WORKTREE_IDENTITY_COLUMNS) {
    if (!columns.has(column)) {
      throw new Error(`delivery autoship worktree identity migration is missing ${column}`)
    }
  }
  const trigger = db.prepare(`SELECT 1 FROM sqlite_master
    WHERE type='trigger' AND name=?`).get(IDENTITY_TRIGGER)
  if (!trigger) {
    throw new Error('delivery autoship worktree identity migration is missing its insert guard')
  }
}
