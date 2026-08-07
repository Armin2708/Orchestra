import Database from 'better-sqlite3'
import { applyAgentOsMigrations } from './agent-os/migrations.js'

const AGENTS_PROVIDER_SESSION_INDEX_SQL =
  `CREATE UNIQUE INDEX agents_provider_session_idx
    ON agents(provider, external_session_id)
    WHERE external_session_id IS NOT NULL`

function normalizeSchemaSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').replace(/;\s*$/, '').trim()
}

function ensureAgentsProviderSessionIndex(db: Database.Database): void {
  const existing = db.prepare(`
    SELECT sql FROM sqlite_master
    WHERE type='index' AND name='agents_provider_session_idx'
  `).get() as { sql: string | null } | undefined
  if (
    existing?.sql
    && normalizeSchemaSql(existing.sql)
      === normalizeSchemaSql(AGENTS_PROVIDER_SESSION_INDEX_SQL)
  ) {
    return
  }
  if (existing) db.exec('DROP INDEX agents_provider_session_idx')
  db.exec(`${AGENTS_PROVIDER_SESSION_INDEX_SQL};`)
}

// Every hot route re-`prepare()`s its SQL text. Profiling the live daemon showed sqlite
// spending as much time *compiling* statements as running them (~520 samples across
// sqlite3RunParser/LockAndPrepare/JS_prepare vs 223 in VdbeExec), because the ~150
// `db.prepare(...)` call sites all sit inside per-request handlers. Statements are
// reusable on a single connection and nothing here mutates one (no .pluck/.raw/
// .iterate/.expand/.safeIntegers anywhere in src), so one memo per connection makes
// every call site cheap without touching them.
const PREPARE_CACHE_MAX = 512

function memoizePrepare(db: Database.Database): void {
  const cache = new Map<string, Database.Statement>()
  const compile = db.prepare.bind(db) as Database.Database['prepare']
  db.prepare = ((sql: string) => {
    const hit = cache.get(sql)
    if (hit) return hit
    const stmt = compile(sql)
    // SQL built by interpolation (variable-length IN lists) would otherwise grow this
    // without bound; the working set is small, so a flush beats tracking recency
    if (cache.size >= PREPARE_CACHE_MAX) cache.clear()
    cache.set(sql, stmt)
    return stmt
  }) as Database.Database['prepare']
}

export function openDb(file: string): Database.Database {
  const db = new Database(file)
  db.pragma('journal_mode = WAL')
  // WAL + NORMAL fsyncs at checkpoint instead of on every commit: a process crash still
  // cannot lose or corrupt a committed transaction, only an OS/power failure can drop
  // the last few. The compatibility sidecar has run this way since the #94/#96 fix; the
  // main board db never got it and was paying a full fsync per write.
  db.pragma('synchronous = NORMAL')
  // the WAL had grown to 5MB unbounded on a live daemon — checkpoint every ~4MB
  db.pragma('wal_autocheckpoint = 1000')
  db.pragma('cache_size = -16000') // 16MB page cache, up from the 2MB default
  db.pragma('foreign_keys = ON')
  memoizePrepare(db)
  db.exec(`
  CREATE TABLE IF NOT EXISTS boards (
    id INTEGER PRIMARY KEY,
    project_path TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS agents (
    id INTEGER PRIMARY KEY,
    board_id INTEGER NOT NULL REFERENCES boards(id),
    name TEXT NOT NULL,
    session_id TEXT,
    status TEXT NOT NULL DEFAULT 'idle',
    last_seen TEXT NOT NULL DEFAULT (datetime('now')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(board_id, name)
  );
  CREATE TABLE IF NOT EXISTS cards (
    id INTEGER PRIMARY KEY,
    board_id INTEGER NOT NULL REFERENCES boards(id),
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    column_name TEXT NOT NULL DEFAULT 'backlog',
    owner_agent_id INTEGER REFERENCES agents(id),
    paths TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS card_events (
    id INTEGER PRIMARY KEY,
    card_id INTEGER NOT NULL REFERENCES cards(id),
    agent_id INTEGER,
    type TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS milestones (
    id INTEGER PRIMARY KEY,
    board_id INTEGER NOT NULL REFERENCES boards(id),
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS ideas (
    id INTEGER PRIMARY KEY,
    board_id INTEGER NOT NULL REFERENCES boards(id),
    text TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS agent_transcripts (
    agent_id INTEGER PRIMARY KEY,
    lines TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS teams (
    id INTEGER PRIMARY KEY,
    board_id INTEGER NOT NULL REFERENCES boards(id),
    name TEXT NOT NULL,
    goal TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'draft',
    lead_agent TEXT,
    spec_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS deliveries (
    message_id INTEGER NOT NULL,
    agent_id INTEGER NOT NULL,
    delivered_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (message_id, agent_id)
  );
  CREATE TABLE IF NOT EXISTS review_decisions (
    id INTEGER PRIMARY KEY,
    board_id INTEGER NOT NULL REFERENCES boards(id),
    card_id INTEGER NOT NULL REFERENCES cards(id),
    milestone_id INTEGER,
    step_order INTEGER,
    decision TEXT NOT NULL,
    note TEXT,
    decided_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS token_telemetry (
    board_id INTEGER NOT NULL,
    agent_id INTEGER NOT NULL,
    hook_event TEXT NOT NULL,
    day TEXT NOT NULL,
    chars INTEGER NOT NULL DEFAULT 0,
    tokens INTEGER NOT NULL DEFAULT 0,
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (board_id, agent_id, hook_event, day)
  );
  CREATE TABLE IF NOT EXISTS agent_usage (
    board_id INTEGER NOT NULL,
    agent_id INTEGER NOT NULL,
    day TEXT NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read INTEGER NOT NULL DEFAULT 0,
    cache_creation INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (board_id, agent_id, day)
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY,
    board_id INTEGER NOT NULL REFERENCES boards(id),
    from_agent_id INTEGER,
    to_agent_id INTEGER,
    card_id INTEGER,
    kind TEXT NOT NULL DEFAULT 'ask',
    body TEXT NOT NULL,
    reply_to INTEGER,
    delivered_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS message_targets (
    message_id INTEGER NOT NULL,
    agent_id INTEGER NOT NULL,
    PRIMARY KEY (message_id, agent_id)
  );
  `)
  try { db.exec(`ALTER TABLE agents ADD COLUMN kind TEXT NOT NULL DEFAULT 'session'`) } catch { /* exists */ }
  try { db.exec(`ALTER TABLE cards ADD COLUMN milestone_id INTEGER`) } catch { /* exists */ }
  try { db.exec(`ALTER TABLE cards ADD COLUMN step_order INTEGER`) } catch { /* exists */ }
  try { db.exec(`ALTER TABLE agents ADD COLUMN role TEXT`) } catch { /* exists */ }
  try { db.exec(`ALTER TABLE agents ADD COLUMN sdk_session TEXT`) } catch { /* exists */ }
  try { db.exec(`ALTER TABLE agents ADD COLUMN permission_mode TEXT`) } catch { /* exists */ }
  try { db.exec(`ALTER TABLE agents ADD COLUMN model TEXT`) } catch { /* exists */ }
  try { db.exec(`ALTER TABLE agents ADD COLUMN effort TEXT`) } catch { /* exists */ }
  try { db.exec(`ALTER TABLE agents ADD COLUMN provider TEXT NOT NULL DEFAULT 'claude'`) } catch { /* exists */ }
  try { db.exec(`ALTER TABLE agents ADD COLUMN external_session_id TEXT`) } catch { /* exists */ }
  try { db.exec(`ALTER TABLE agents ADD COLUMN team_id INTEGER REFERENCES teams(id)`) } catch { /* exists */ }
  try { db.exec(`ALTER TABLE agents ADD COLUMN team_role TEXT`) } catch { /* exists */ }
  try { db.exec(`ALTER TABLE agents ADD COLUMN provider_state_json TEXT NOT NULL DEFAULT '{}'`) } catch { /* exists */ }
  try { db.exec(`ALTER TABLE agents ADD COLUMN access_profile TEXT`) } catch { /* exists */ }
  try { db.exec(`ALTER TABLE agents ADD COLUMN hook_token_hash TEXT`) } catch { /* exists */ }
  // Keep the Claude SDK session column for one compatibility window. New provider
  // integrations use the namespaced provider + external_session_id identity.
  db.exec(`
    UPDATE agents SET provider='claude' WHERE provider IS NULL OR trim(provider)='';
    UPDATE agents SET external_session_id=sdk_session
      WHERE provider='claude' AND external_session_id IS NULL AND sdk_session IS NOT NULL
        AND id=(SELECT MAX(candidate.id) FROM agents candidate
          WHERE candidate.provider='claude' AND candidate.sdk_session=agents.sdk_session);
    UPDATE agents SET external_session_id=NULL
      WHERE external_session_id IS NOT NULL
        AND id NOT IN (SELECT MAX(candidate.id) FROM agents candidate
          WHERE candidate.external_session_id IS NOT NULL
          GROUP BY candidate.provider, candidate.external_session_id);
    CREATE INDEX IF NOT EXISTS agents_board_provider_status_idx
      ON agents(board_id, provider, status);
    CREATE TRIGGER IF NOT EXISTS agents_sync_claude_session_insert
      AFTER INSERT ON agents
      WHEN NEW.provider='claude' AND NEW.sdk_session IS NOT NULL AND NEW.external_session_id IS NULL
      BEGIN
        UPDATE agents SET external_session_id=NEW.sdk_session WHERE id=NEW.id;
      END;
    CREATE TRIGGER IF NOT EXISTS agents_sync_claude_session_update
      AFTER UPDATE OF sdk_session ON agents
      WHEN NEW.provider='claude'
        AND (NEW.external_session_id IS NULL OR NEW.external_session_id IS OLD.sdk_session)
      BEGIN
        UPDATE agents SET external_session_id=NEW.sdk_session WHERE id=NEW.id;
      END;
  `)
  ensureAgentsProviderSessionIndex(db)
  try { db.exec(`ALTER TABLE agent_usage ADD COLUMN provider TEXT NOT NULL DEFAULT 'claude'`) } catch { /* exists */ }
  try { db.exec(`ALTER TABLE agent_usage ADD COLUMN total_tokens INTEGER NOT NULL DEFAULT 0`) } catch { /* exists */ }
  try { db.exec(`ALTER TABLE agent_usage ADD COLUMN cached_input_tokens INTEGER NOT NULL DEFAULT 0`) } catch { /* exists */ }
  try { db.exec(`ALTER TABLE agent_usage ADD COLUMN reasoning_output_tokens INTEGER NOT NULL DEFAULT 0`) } catch { /* exists */ }
  try { db.exec(`ALTER TABLE agent_usage ADD COLUMN cost_cents INTEGER`) } catch { /* exists */ }
  db.exec(`
    UPDATE agent_usage
      SET provider=COALESCE(
        (SELECT provider FROM agents WHERE agents.id=agent_usage.agent_id),
        provider,
        'claude'
      )
      WHERE provider IS NOT COALESCE(
        (SELECT provider FROM agents WHERE agents.id=agent_usage.agent_id),
        provider,
        'claude'
      );
    UPDATE agent_usage
      SET total_tokens=input_tokens + cache_read + cache_creation + output_tokens
      WHERE total_tokens=0 AND (input_tokens + cache_read + cache_creation + output_tokens) > 0;
    UPDATE agent_usage SET cached_input_tokens=cache_read
      WHERE cached_input_tokens=0 AND cache_read > 0;
    UPDATE agent_usage SET cache_read=0, cache_creation=0
      WHERE provider='codex' AND (cache_read!=0 OR cache_creation!=0);
    CREATE INDEX IF NOT EXISTS agent_usage_board_provider_day_idx
      ON agent_usage(board_id, provider, day);
  `)
  try { db.exec(`ALTER TABLE cards ADD COLUMN branch TEXT`) } catch { /* exists */ }
  // stack-ranked backlog (spec 2026-08-04-backlog-system): smaller rank = higher priority
  try { db.exec(`ALTER TABLE cards ADD COLUMN rank REAL`) } catch { /* exists */ }
  // milestones act as epics: lifecycle status + shipped outcome
  try { db.exec(`ALTER TABLE milestones ADD COLUMN status TEXT NOT NULL DEFAULT 'open'`) } catch { /* exists */ }
  try { db.exec(`ALTER TABLE milestones ADD COLUMN outcome TEXT NOT NULL DEFAULT ''`) } catch { /* exists */ }
  try { db.exec(`ALTER TABLE milestones ADD COLUMN rank REAL`) } catch { /* exists */ }
  // Existing targeted mail retains ask semantics. Old targetless rows become inert for
  // agents because only explicit, snapshotted swarms enter the fan-out inbox path.
  try { db.exec(`ALTER TABLE messages ADD COLUMN kind TEXT NOT NULL DEFAULT 'ask'`) } catch { /* exists */ }
  // operator mail (#99): a message is inbox mail only when explicitly addressed to the
  // human (to_human=1) — targetless broadcasts stay board coordination traffic
  try { db.exec(`ALTER TABLE messages ADD COLUMN to_human INTEGER NOT NULL DEFAULT 0`) } catch { /* exists */ }
  try { db.exec(`ALTER TABLE messages ADD COLUMN subject TEXT`) } catch { /* exists */ }
  try { db.exec(`ALTER TABLE messages ADD COLUMN mail_type TEXT`) } catch { /* exists */ }
  try { db.exec(`ALTER TABLE messages ADD COLUMN attachments TEXT`) } catch { /* exists */ }
  applyAgentOsMigrations(db)
  return db
}
