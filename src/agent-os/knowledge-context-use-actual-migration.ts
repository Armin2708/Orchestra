import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'

export const AGENT_OS_KNOWLEDGE_CONTEXT_USE_ACTUAL_MIGRATION_ID =
  '036-knowledge-context-use-actual-evidence'

export const KNOWLEDGE_CONTEXT_USE_ACTUAL_TABLE_SQL = `CREATE TABLE context_uses (
  board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE RESTRICT,
  id TEXT NOT NULL
    CHECK(length(id)=67
      AND substr(id, 1, 3)='cu_'
      AND substr(id, 4) NOT GLOB '*[^0-9a-f]*'),
  context_build_id TEXT NOT NULL,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  session_id TEXT NOT NULL REFERENCES agent_sessions(id),
  injection_ordinal INTEGER NOT NULL CHECK(injection_ordinal>=0),
  manifest_fingerprint TEXT NOT NULL
    CHECK(length(manifest_fingerprint)=64
      AND manifest_fingerprint NOT GLOB '*[^0-9a-f]*'),
  estimated_tokens INTEGER NOT NULL
    CHECK(estimated_tokens BETWEEN 0 AND 10000000),
  actual_tokens INTEGER
    CHECK(actual_tokens IS NULL OR actual_tokens BETWEEN 0 AND 10000000),
  cache_identity TEXT NOT NULL CHECK(length(cache_identity)>0),
  outcome TEXT NOT NULL
    CHECK(outcome IN ('running', 'completed', 'failed', 'cancelled')),
  injected_at TEXT NOT NULL CHECK(length(injected_at)>0),
  completed_at TEXT,
  PRIMARY KEY(board_id, id),
  UNIQUE(board_id, session_id, injection_ordinal),
  FOREIGN KEY(board_id, context_build_id)
    REFERENCES context_builds(board_id, id),
  CHECK(
    (outcome='running' AND actual_tokens IS NULL AND completed_at IS NULL)
    OR (
      outcome!='running'
      AND completed_at IS NOT NULL
      AND completed_at>=injected_at
    )
  )
)`

const LEGACY_CONTEXT_USES_TABLE_HASH =
  '4539beb67a5e99e444fe5a6ff9c72d8f65457c875e968de8fdb45b14b9810563'
const TEMPORARY_TABLE = 'context_uses_actual_evidence'
const CONTEXT_USE_COLUMNS = `board_id, id, context_build_id, job_id, session_id,
  injection_ordinal, manifest_fingerprint, estimated_tokens, actual_tokens,
  cache_identity, outcome, injected_at, completed_at`
const INDEXES = [
  'idx_context_uses_build',
  'idx_context_uses_job',
] as const
const TRIGGERS = [
  'context_uses_delete',
  'context_uses_finish',
  'context_uses_insert',
  'context_uses_mark_build_used',
] as const
const PRESERVED_TRIGGERS = TRIGGERS.filter((name) => name !== 'context_uses_finish')
const LEGACY_FINISH_CLAUSE = "OR (NEW.outcome='completed' AND NEW.actual_tokens IS NULL)"
const CURRENT_FINISH_TRIGGER_SQL = `CREATE TRIGGER context_uses_finish
BEFORE UPDATE ON context_uses
WHEN NEW.board_id IS NOT OLD.board_id
  OR NEW.id IS NOT OLD.id
  OR NEW.context_build_id IS NOT OLD.context_build_id
  OR NEW.job_id IS NOT OLD.job_id
  OR NEW.session_id IS NOT OLD.session_id
  OR NEW.injection_ordinal IS NOT OLD.injection_ordinal
  OR NEW.manifest_fingerprint IS NOT OLD.manifest_fingerprint
  OR NEW.estimated_tokens IS NOT OLD.estimated_tokens
  OR NEW.cache_identity IS NOT OLD.cache_identity
  OR NEW.injected_at IS NOT OLD.injected_at
  OR OLD.outcome!='running'
  OR NEW.outcome NOT IN ('completed', 'failed', 'cancelled')
  OR NEW.completed_at IS NULL
  OR NEW.completed_at<OLD.injected_at
BEGIN
  SELECT RAISE(ABORT, 'context use identity or lifecycle is immutable');
END`

type SchemaObject = {
  type: 'table' | 'index' | 'trigger'
  name: string
  sql: string | null
}

const normalizedSql = (value: string): string => value.trim()
const normalizedObjectSql = (value: string): string => value.replace(/\s+/g, ' ').trim()
const sqlHash = (value: string): string => createHash('sha256')
  .update(normalizedSql(value)).digest('hex')

function contextUseObjects(db: Database.Database): SchemaObject[] {
  return db.prepare(`SELECT type, name, sql FROM sqlite_master
    WHERE tbl_name='context_uses'
      AND type IN ('table', 'index', 'trigger')
      AND name NOT LIKE 'sqlite_autoindex_%'
    ORDER BY type, name`).all() as SchemaObject[]
}

function inventoryMatches(objects: SchemaObject[]): boolean {
  const indexes = objects.filter((object) => object.type === 'index').map(({ name }) => name)
  const triggers = objects.filter((object) => object.type === 'trigger').map(({ name }) => name)
  return indexes.length === INDEXES.length
    && indexes.every((name, index) => name === INDEXES[index])
    && triggers.length === TRIGGERS.length
    && triggers.every((name, index) => name === TRIGGERS[index])
}

function schemaState(db: Database.Database): 'legacy' | 'current' | 'invalid' {
  const objects = contextUseObjects(db)
  const table = objects.find((object) => object.type === 'table')
  const finish = objects.find((object) => object.name === 'context_uses_finish')
  if (!table?.sql || !finish?.sql || !inventoryMatches(objects)) return 'invalid'
  const tableHash = sqlHash(table.sql)
  const normalizedFinish = normalizedObjectSql(finish.sql)
  if (
    tableHash === sqlHash(KNOWLEDGE_CONTEXT_USE_ACTUAL_TABLE_SQL)
    && normalizedFinish === normalizedObjectSql(CURRENT_FINISH_TRIGGER_SQL)
  ) return 'current'
  if (
    tableHash === LEGACY_CONTEXT_USES_TABLE_HASH
    && normalizedFinish.includes(LEGACY_FINISH_CLAUSE)
  ) return 'legacy'
  return 'invalid'
}

function assertCurrentSchema(db: Database.Database, expectedRows: number): void {
  if (schemaState(db) !== 'current') {
    throw new Error('migration 036 found an incompatible context use schema')
  }
  const rows = (db.prepare('SELECT COUNT(*) AS count FROM context_uses').get() as {
    count: number
  }).count
  if (rows !== expectedRows || db.prepare('PRAGMA foreign_key_check').all().length > 0) {
    throw new Error('migration 036 failed to preserve context use evidence')
  }
}

export function installKnowledgeContextUseActualEvidenceSchema(
  db: Database.Database,
): void {
  const state = schemaState(db)
  const expectedRows = (db.prepare('SELECT COUNT(*) AS count FROM context_uses').get() as {
    count: number
  }).count
  if (state === 'current') {
    assertCurrentSchema(db, expectedRows)
    return
  }
  if (state !== 'legacy') {
    throw new Error('migration 036 found an incompatible context use schema')
  }
  const preserved = contextUseObjects(db)
    .filter((object) => PRESERVED_TRIGGERS.includes(object.name as typeof PRESERVED_TRIGGERS[number]))
  if (preserved.length !== PRESERVED_TRIGGERS.length || preserved.some((object) => !object.sql)) {
    throw new Error('migration 036 found incomplete context use lifecycle triggers')
  }
  const temporarySql = KNOWLEDGE_CONTEXT_USE_ACTUAL_TABLE_SQL.replace(
    'CREATE TABLE context_uses',
    `CREATE TABLE ${TEMPORARY_TABLE}`,
  )
  db.exec(`
    DROP TRIGGER context_uses_delete;
    DROP TRIGGER context_uses_finish;
    DROP TRIGGER context_uses_insert;
    DROP TRIGGER context_uses_mark_build_used;
    DROP INDEX idx_context_uses_build;
    DROP INDEX idx_context_uses_job;
    ${temporarySql};
    INSERT INTO ${TEMPORARY_TABLE} (${CONTEXT_USE_COLUMNS})
      SELECT ${CONTEXT_USE_COLUMNS} FROM context_uses;
    DROP TABLE context_uses;
    ${KNOWLEDGE_CONTEXT_USE_ACTUAL_TABLE_SQL};
    INSERT INTO context_uses (${CONTEXT_USE_COLUMNS})
      SELECT ${CONTEXT_USE_COLUMNS} FROM ${TEMPORARY_TABLE};
    DROP TABLE ${TEMPORARY_TABLE};
    CREATE INDEX idx_context_uses_build
      ON context_uses(board_id, context_build_id, injected_at, id);
    CREATE INDEX idx_context_uses_job
      ON context_uses(board_id, job_id, session_id, injection_ordinal);
  `)
  for (const trigger of preserved) db.exec(trigger.sql!)
  db.exec(CURRENT_FINISH_TRIGGER_SQL)
  assertCurrentSchema(db, expectedRows)
}
