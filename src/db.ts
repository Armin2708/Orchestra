import Database from 'better-sqlite3'
import { applyAgentOsMigrations } from './agent-os/migrations.js'

export function openDb(file: string): Database.Database {
  const db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
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
    status TEXT NOT NULL DEFAULT 'active',
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
    DROP INDEX IF EXISTS agents_provider_session_idx;
    CREATE UNIQUE INDEX IF NOT EXISTS agents_provider_session_idx
      ON agents(provider, external_session_id) WHERE external_session_id IS NOT NULL;
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
  // Existing targeted mail retains ask semantics. Old targetless rows become inert for
  // agents because only explicit, snapshotted swarms enter the fan-out inbox path.
  try { db.exec(`ALTER TABLE messages ADD COLUMN kind TEXT NOT NULL DEFAULT 'ask'`) } catch { /* exists */ }
  applyAgentOsMigrations(db)
  return db
}
