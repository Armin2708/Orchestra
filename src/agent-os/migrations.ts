import type Database from 'better-sqlite3'

interface Migration {
  id: string
  apply(db: Database.Database): void
}

const migrations: Migration[] = [
  {
    id: '001-agent-os-kernel',
    apply(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS workspaces (
          id TEXT PRIMARY KEY,
          board_id INTEGER NOT NULL REFERENCES boards(id),
          card_id INTEGER REFERENCES cards(id) ON DELETE SET NULL,
          name TEXT NOT NULL,
          kind TEXT NOT NULL,
          root_path TEXT NOT NULL,
          worktree_path TEXT,
          branch TEXT,
          base_ref TEXT,
          status TEXT NOT NULL DEFAULT 'active',
          env_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS agent_sessions (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          agent_id INTEGER REFERENCES agents(id) ON DELETE SET NULL,
          provider TEXT NOT NULL,
          external_id TEXT,
          model TEXT,
          status TEXT NOT NULL DEFAULT 'starting',
          context_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS processes (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          command TEXT NOT NULL,
          cwd TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'starting',
          pid INTEGER,
          exit_code INTEGER,
          cols INTEGER NOT NULL DEFAULT 80,
          rows INTEGER NOT NULL DEFAULT 24,
          restartable INTEGER NOT NULL DEFAULT 0,
          started_at TEXT,
          ended_at TEXT
        );

        CREATE TABLE IF NOT EXISTS process_output (
          id INTEGER PRIMARY KEY,
          process_id TEXT NOT NULL REFERENCES processes(id) ON DELETE CASCADE,
          seq INTEGER NOT NULL,
          stream TEXT NOT NULL,
          data TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(process_id, seq)
        );

        CREATE TABLE IF NOT EXISTS os_events (
          id TEXT PRIMARY KEY,
          board_id INTEGER NOT NULL,
          workspace_id TEXT,
          card_id INTEGER,
          session_id TEXT,
          process_id TEXT,
          kind TEXT NOT NULL,
          source TEXT NOT NULL,
          payload TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS artifacts (
          id TEXT PRIMARY KEY,
          board_id INTEGER NOT NULL,
          workspace_id TEXT,
          card_id INTEGER,
          kind TEXT NOT NULL,
          name TEXT NOT NULL,
          mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
          path TEXT,
          content TEXT,
          metadata TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS policies (
          id TEXT PRIMARY KEY,
          board_id INTEGER NOT NULL REFERENCES boards(id),
          name TEXT NOT NULL,
          file_globs TEXT NOT NULL DEFAULT '[]',
          command_globs TEXT NOT NULL DEFAULT '[]',
          network_hosts TEXT NOT NULL DEFAULT '[]',
          secret_names TEXT NOT NULL DEFAULT '[]',
          approval_scope TEXT NOT NULL DEFAULT 'advisory',
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS task_contracts (
          card_id INTEGER PRIMARY KEY REFERENCES cards(id) ON DELETE CASCADE,
          objective TEXT NOT NULL,
          acceptance_criteria TEXT NOT NULL DEFAULT '[]',
          dependencies TEXT NOT NULL DEFAULT '[]',
          base_ref TEXT,
          verify_commands TEXT NOT NULL DEFAULT '[]',
          budget_tokens INTEGER,
          budget_cents INTEGER,
          priority INTEGER NOT NULL DEFAULT 0,
          policy_id TEXT REFERENCES policies(id) ON DELETE SET NULL,
          workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS attention_items (
          id TEXT PRIMARY KEY,
          board_id INTEGER NOT NULL,
          workspace_id TEXT,
          card_id INTEGER,
          agent_id INTEGER,
          kind TEXT NOT NULL,
          severity TEXT NOT NULL DEFAULT 'medium',
          title TEXT NOT NULL,
          detail TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'open',
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          resolved_at TEXT
        );

        CREATE TABLE IF NOT EXISTS checkpoints (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL REFERENCES workspaces(id),
          session_id TEXT,
          name TEXT NOT NULL,
          git_head TEXT NOT NULL,
          patch_artifact_id TEXT REFERENCES artifacts(id),
          context_json TEXT NOT NULL DEFAULT '{}',
          process_recipes TEXT NOT NULL DEFAULT '[]',
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS jobs (
          id TEXT PRIMARY KEY,
          board_id INTEGER NOT NULL,
          card_id INTEGER,
          workspace_id TEXT,
          provider TEXT NOT NULL,
          model TEXT,
          priority INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'queued',
          attempts INTEGER NOT NULL DEFAULT 0,
          max_attempts INTEGER NOT NULL DEFAULT 1,
          budget_tokens INTEGER,
          budget_cents INTEGER,
          scheduled_at TEXT NOT NULL DEFAULT (datetime('now')),
          started_at TEXT,
          finished_at TEXT,
          error TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS context_items (
          id TEXT PRIMARY KEY,
          board_id INTEGER NOT NULL,
          workspace_id TEXT,
          card_id INTEGER,
          kind TEXT NOT NULL,
          source TEXT NOT NULL,
          content TEXT NOT NULL,
          tokens INTEGER NOT NULL DEFAULT 0,
          pinned INTEGER NOT NULL DEFAULT 0,
          provenance TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_workspaces_board ON workspaces(board_id, status);
        CREATE INDEX IF NOT EXISTS idx_workspaces_card ON workspaces(card_id);
        CREATE INDEX IF NOT EXISTS idx_sessions_workspace ON agent_sessions(workspace_id, status);
        CREATE INDEX IF NOT EXISTS idx_processes_workspace ON processes(workspace_id, status);
        CREATE INDEX IF NOT EXISTS idx_process_output_cursor ON process_output(process_id, seq);
        CREATE INDEX IF NOT EXISTS idx_os_events_board ON os_events(board_id, created_at, id);
        CREATE INDEX IF NOT EXISTS idx_os_events_workspace ON os_events(workspace_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_os_events_card ON os_events(card_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_artifacts_card ON artifacts(card_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_artifacts_workspace ON artifacts(workspace_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_attention_board ON attention_items(board_id, status, created_at);
        CREATE INDEX IF NOT EXISTS idx_checkpoints_workspace ON checkpoints(workspace_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_jobs_queue ON jobs(status, priority, scheduled_at);
        CREATE INDEX IF NOT EXISTS idx_jobs_board ON jobs(board_id, status, created_at);
        CREATE INDEX IF NOT EXISTS idx_context_workspace ON context_items(workspace_id, pinned, updated_at);
      `)
    },
  },
]

/** Apply each Agent OS migration exactly once, atomically, and without touching legacy tables. */
export function applyAgentOsMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS os_schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)

  const applied = db.prepare('SELECT 1 FROM os_schema_migrations WHERE id = ?')
  const record = db.prepare('INSERT INTO os_schema_migrations (id) VALUES (?)')
  const migrate = db.transaction(() => {
    for (const migration of migrations) {
      if (applied.get(migration.id)) continue
      migration.apply(db)
      record.run(migration.id)
    }
  })
  migrate()
}
