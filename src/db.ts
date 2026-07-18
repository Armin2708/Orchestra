import Database from 'better-sqlite3'

export function openDb(file: string): Database.Database {
  const db = new Database(file)
  db.pragma('journal_mode = WAL')
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
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY,
    board_id INTEGER NOT NULL REFERENCES boards(id),
    from_agent_id INTEGER,
    to_agent_id INTEGER,
    card_id INTEGER,
    body TEXT NOT NULL,
    reply_to INTEGER,
    delivered_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
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
  return db
}
