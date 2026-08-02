import { createHmac, randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { redactSensitiveText } from './structured-redaction.js'

/**
 * Root integration must register this SQL under the next global migration ID.
 * It is intentionally additive and does not alter the existing processes or
 * process_output byte-stream tables.
 */
export const TERMINAL_SESSION_STATE_SCHEMA_SQL = `
  CREATE TABLE terminal_workspace_state (
    workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
    selected_process_id TEXT REFERENCES processes(id) ON DELETE SET NULL,
    selected_at TEXT,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE terminal_command_history (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    process_id TEXT NOT NULL REFERENCES processes(id) ON DELETE CASCADE,
    session_id TEXT REFERENCES agent_sessions(id) ON DELETE SET NULL,
    seq INTEGER NOT NULL CHECK(seq >= 1),
    source TEXT NOT NULL CHECK(source IN ('human', 'driver')),
    retention TEXT NOT NULL CHECK(retention IN ('hash_only', 'redacted_text')),
    command_digest TEXT NOT NULL CHECK(length(command_digest) = 64),
    projected_text TEXT,
    redaction_state TEXT NOT NULL CHECK(redaction_state IN ('none', 'redacted', 'withheld')),
    redactions INTEGER NOT NULL CHECK(redactions >= 0),
    created_at TEXT NOT NULL,
    UNIQUE(workspace_id, seq),
    CHECK(
      (retention = 'hash_only' AND projected_text IS NULL AND redaction_state = 'withheld')
      OR retention = 'redacted_text'
    )
  );

  CREATE INDEX idx_terminal_command_history_process
    ON terminal_command_history(process_id, seq);
  CREATE INDEX idx_terminal_command_history_session
    ON terminal_command_history(session_id, seq)
    WHERE session_id IS NOT NULL;

  CREATE TRIGGER terminal_workspace_state_process_insert_guard
  BEFORE INSERT ON terminal_workspace_state
  WHEN NEW.selected_process_id IS NOT NULL
  BEGIN
    SELECT CASE WHEN NOT EXISTS (
      SELECT 1 FROM processes
      WHERE id = NEW.selected_process_id AND workspace_id = NEW.workspace_id
    ) THEN RAISE(ABORT, 'selected terminal process must belong to the workspace') END;
  END;

  CREATE TRIGGER terminal_workspace_state_process_update_guard
  BEFORE UPDATE OF workspace_id, selected_process_id ON terminal_workspace_state
  WHEN NEW.selected_process_id IS NOT NULL
  BEGIN
    SELECT CASE WHEN NOT EXISTS (
      SELECT 1 FROM processes
      WHERE id = NEW.selected_process_id AND workspace_id = NEW.workspace_id
    ) THEN RAISE(ABORT, 'selected terminal process must belong to the workspace') END;
  END;

  CREATE TRIGGER terminal_command_history_scope_insert_guard
  BEFORE INSERT ON terminal_command_history
  BEGIN
    SELECT CASE WHEN NOT EXISTS (
      SELECT 1 FROM processes
      WHERE id = NEW.process_id AND workspace_id = NEW.workspace_id
    ) THEN RAISE(ABORT, 'terminal history process must belong to the workspace') END;
    SELECT CASE WHEN NEW.session_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM agent_sessions
      WHERE id = NEW.session_id AND workspace_id = NEW.workspace_id
    ) THEN RAISE(ABORT, 'terminal history session must belong to the workspace') END;
  END;

  CREATE TRIGGER terminal_command_history_immutable_guard
  BEFORE UPDATE ON terminal_command_history
  WHEN NOT (
    OLD.session_id IS NOT NULL
    AND NEW.session_id IS NULL
    AND NEW.id IS OLD.id
    AND NEW.workspace_id IS OLD.workspace_id
    AND NEW.process_id IS OLD.process_id
    AND NEW.seq IS OLD.seq
    AND NEW.source IS OLD.source
    AND NEW.retention IS OLD.retention
    AND NEW.command_digest IS OLD.command_digest
    AND NEW.projected_text IS OLD.projected_text
    AND NEW.redaction_state IS OLD.redaction_state
    AND NEW.redactions IS OLD.redactions
    AND NEW.created_at IS OLD.created_at
  )
  BEGIN
    SELECT RAISE(ABORT, 'terminal command history is immutable');
  END;
`

export type TerminalWorkspaceState = {
  workspaceId: string
  selectedProcessId: string | null
  selectedAt: string | null
  updatedAt: string | null
}

export type TerminalCommandHistoryRecord = {
  id: string
  workspaceId: string
  processId: string
  sessionId: string | null
  seq: number
  source: 'human' | 'driver'
  retention: 'hash_only' | 'redacted_text'
  commandDigest: string
  projectedText: string | null
  redactionState: 'none' | 'redacted' | 'withheld'
  redactions: number
  createdAt: string
}

export type RecordTerminalCommand = {
  workspaceId: string
  processId: string
  sessionId?: string | null
  command: string
  source?: 'human' | 'driver'
  retention?: 'hash_only' | 'redacted_text'
}

export type TerminalRestartSnapshot = {
  workspaceId: string
  selectedProcessId: string | null
  processes: Array<{
    id: string
    name: string
    command: string
    cwd: string
    status: string
    cols: number
    rows: number
    restartable: boolean
    restartRecipeAvailable: boolean
  }>
}

export type TerminalSessionStateOptions = {
  digestKey: string | Buffer
  now?: () => string
  id?: () => string
}

export class TerminalSessionStateService {
  private readonly digestKey: Buffer
  private readonly now: () => string
  private readonly id: () => string

  constructor(
    private readonly db: Database.Database,
    options: TerminalSessionStateOptions,
  ) {
    this.digestKey = Buffer.isBuffer(options.digestKey)
      ? Buffer.from(options.digestKey)
      : Buffer.from(options.digestKey, 'utf8')
    if (this.digestKey.byteLength < 32) throw new Error('terminal history digestKey must contain at least 32 bytes')
    this.now = options.now ?? (() => new Date().toISOString())
    this.id = options.id ?? randomUUID
  }

  selectProcess(workspaceId: string, processId: string | null): TerminalWorkspaceState {
    requiredId(workspaceId, 'workspaceId')
    if (processId !== null) requiredId(processId, 'processId')
    const now = validTimestamp(this.now(), 'now')
    this.db.prepare(`INSERT INTO terminal_workspace_state (
        workspace_id, selected_process_id, selected_at, updated_at
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(workspace_id) DO UPDATE SET
        selected_process_id=excluded.selected_process_id,
        selected_at=excluded.selected_at,
        updated_at=excluded.updated_at`).run(
      workspaceId,
      processId,
      processId === null ? null : now,
      now,
    )
    return this.getWorkspaceState(workspaceId)
  }

  getWorkspaceState(workspaceId: string): TerminalWorkspaceState {
    requiredId(workspaceId, 'workspaceId')
    const row = this.db.prepare(`SELECT workspace_id, selected_process_id, selected_at, updated_at
      FROM terminal_workspace_state WHERE workspace_id=?`).get(workspaceId) as StateRow | undefined
    return row
      ? mapState(row)
      : {
          workspaceId,
          selectedProcessId: null,
          selectedAt: null,
          updatedAt: null,
        }
  }

  recordCommand(input: RecordTerminalCommand): TerminalCommandHistoryRecord {
    requiredId(input.workspaceId, 'workspaceId')
    requiredId(input.processId, 'processId')
    if (input.sessionId != null) requiredId(input.sessionId, 'sessionId')
    if (typeof input.command !== 'string' || input.command.length < 1) throw new Error('command is required')
    if (Buffer.byteLength(input.command) > 64 * 1024) throw new Error('command exceeds the 64 KiB limit')
    const source = input.source ?? 'human'
    const retention = input.retention ?? 'hash_only'
    const redacted = redactSensitiveText(input.command)
    const safeCommand = redacted.value ?? ''
    const rowId = requiredId(this.id(), 'generated command history id')
    const createdAt = validTimestamp(this.now(), 'now')
    const commandDigest = createHmac('sha256', this.digestKey)
      .update(safeCommand, 'utf8')
      .digest('hex')
    const projectedText = retention === 'redacted_text' ? safeCommand : null
    const redactionState = retention === 'hash_only'
      ? 'withheld'
      : redacted.redactions > 0 ? 'redacted' : 'none'

    const insert = this.db.transaction(() => {
      const seqRow = this.db.prepare(`SELECT COALESCE(MAX(seq), 0) + 1 AS seq
        FROM terminal_command_history WHERE workspace_id=?`).get(input.workspaceId) as { seq: number }
      this.db.prepare(`INSERT INTO terminal_command_history (
          id, workspace_id, process_id, session_id, seq, source, retention,
          command_digest, projected_text, redaction_state, redactions, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        rowId,
        input.workspaceId,
        input.processId,
        input.sessionId ?? null,
        seqRow.seq,
        source,
        retention,
        commandDigest,
        projectedText,
        redactionState,
        redacted.redactions,
        createdAt,
      )
      return this.requireHistory(rowId)
    })
    return insert.immediate()
  }

  listHistory(input: {
    workspaceId: string
    sessionId?: string
    processId?: string
    afterSeq?: number
    limit?: number
  }): TerminalCommandHistoryRecord[] {
    requiredId(input.workspaceId, 'workspaceId')
    const afterSeq = input.afterSeq ?? 0
    const limit = input.limit ?? 100
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) throw new Error('afterSeq must be a non-negative integer')
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error('limit must be between 1 and 500')
    const filters = ['workspace_id=@workspace_id', 'seq>@after_seq']
    if (input.sessionId !== undefined) {
      requiredId(input.sessionId, 'sessionId')
      filters.push('session_id=@session_id')
    }
    if (input.processId !== undefined) {
      requiredId(input.processId, 'processId')
      filters.push('process_id=@process_id')
    }
    const rows = this.db.prepare(`SELECT * FROM terminal_command_history
      WHERE ${filters.join(' AND ')} ORDER BY seq ASC LIMIT @limit`).all({
      workspace_id: input.workspaceId,
      after_seq: afterSeq,
      session_id: input.sessionId ?? null,
      process_id: input.processId ?? null,
      limit,
    }) as HistoryRow[]
    return rows.map(mapHistory)
  }

  restartSnapshot(workspaceId: string): TerminalRestartSnapshot {
    requiredId(workspaceId, 'workspaceId')
    const state = this.getWorkspaceState(workspaceId)
    const rows = this.db.prepare(`SELECT id, name, command, cwd, status, cols, rows,
        restartable, recipe_json
      FROM processes WHERE workspace_id=? ORDER BY rowid`).all(workspaceId) as ProcessRow[]
    return {
      workspaceId,
      selectedProcessId: state.selectedProcessId,
      processes: rows.map((row) => ({
        id: row.id,
        name: row.name,
        command: row.command,
        cwd: row.cwd,
        status: row.status,
        cols: row.cols,
        rows: row.rows,
        restartable: row.restartable === 1,
        restartRecipeAvailable: row.restartable === 1 && validRestartRecipe(row.recipe_json),
      })),
    }
  }

  private requireHistory(id: string): TerminalCommandHistoryRecord {
    const row = this.db.prepare('SELECT * FROM terminal_command_history WHERE id=?').get(id) as HistoryRow | undefined
    if (!row) throw new Error(`terminal command history ${id} was not persisted`)
    return mapHistory(row)
  }
}

type StateRow = {
  workspace_id: string
  selected_process_id: string | null
  selected_at: string | null
  updated_at: string
}

type HistoryRow = {
  id: string
  workspace_id: string
  process_id: string
  session_id: string | null
  seq: number
  source: 'human' | 'driver'
  retention: 'hash_only' | 'redacted_text'
  command_digest: string
  projected_text: string | null
  redaction_state: 'none' | 'redacted' | 'withheld'
  redactions: number
  created_at: string
}

type ProcessRow = {
  id: string
  name: string
  command: string
  cwd: string
  status: string
  cols: number
  rows: number
  restartable: number
  recipe_json: string
}

function mapState(row: StateRow): TerminalWorkspaceState {
  return {
    workspaceId: row.workspace_id,
    selectedProcessId: row.selected_process_id,
    selectedAt: row.selected_at,
    updatedAt: row.updated_at,
  }
}

function mapHistory(row: HistoryRow): TerminalCommandHistoryRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    processId: row.process_id,
    sessionId: row.session_id,
    seq: row.seq,
    source: row.source,
    retention: row.retention,
    commandDigest: row.command_digest,
    projectedText: row.projected_text,
    redactionState: row.redaction_state,
    redactions: row.redactions,
    createdAt: row.created_at,
  }
}

function requiredId(value: string, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`)
  if (value.length > 512) throw new Error(`${name} exceeds 512 characters`)
  return value
}

function validTimestamp(value: string, name: string): string {
  if (Number.isNaN(Date.parse(value))) throw new Error(`${name} must be an ISO timestamp`)
  return value
}

function validRestartRecipe(value: string): boolean {
  try {
    const recipe = JSON.parse(value) as Record<string, unknown>
    return typeof recipe.command === 'string'
      && recipe.command.length > 0
      && typeof recipe.cwd === 'string'
      && recipe.cwd.length > 0
      && Number.isInteger(recipe.cols)
      && Number.isInteger(recipe.rows)
  } catch {
    return false
  }
}
