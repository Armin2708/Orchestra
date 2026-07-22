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
  {
    id: '002-runtime-hardening',
    apply(db) {
      db.exec(`
        ALTER TABLE processes ADD COLUMN recipe_json TEXT NOT NULL DEFAULT '{}';
        ALTER TABLE jobs ADD COLUMN spent_tokens INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE jobs ADD COLUMN spent_cents INTEGER NOT NULL DEFAULT 0;

        CREATE TABLE daemon_leases (
          name TEXT PRIMARY KEY,
          owner_id TEXT NOT NULL,
          pid INTEGER NOT NULL,
          acquired_at TEXT NOT NULL,
          heartbeat_at TEXT NOT NULL
        );

        CREATE TRIGGER jobs_one_active_card_insert
        BEFORE INSERT ON jobs
        WHEN NEW.card_id IS NOT NULL AND NEW.status IN ('queued', 'running', 'cancelling')
        BEGIN
          SELECT CASE WHEN EXISTS (
            SELECT 1 FROM jobs
            WHERE card_id = NEW.card_id AND status IN ('queued', 'running', 'cancelling')
          ) THEN RAISE(ABORT, 'card already has an active job') END;
        END;

        CREATE TRIGGER jobs_one_active_card_update
        BEFORE UPDATE OF card_id, status ON jobs
        WHEN NEW.card_id IS NOT NULL AND NEW.status IN ('queued', 'running', 'cancelling')
        BEGIN
          SELECT CASE WHEN EXISTS (
            SELECT 1 FROM jobs
            WHERE card_id = NEW.card_id AND id != NEW.id AND status IN ('queued', 'running', 'cancelling')
          ) THEN RAISE(ABORT, 'card already has an active job') END;
        END;

        CREATE TRIGGER workspaces_unique_active_worktree_insert
        BEFORE INSERT ON workspaces
        WHEN NEW.kind = 'worktree' AND NEW.status = 'active'
        BEGIN
          SELECT CASE WHEN EXISTS (
            SELECT 1 FROM workspaces
            WHERE kind = 'worktree' AND status = 'active'
              AND (worktree_path = NEW.worktree_path OR (root_path = NEW.root_path AND branch = NEW.branch))
          ) THEN RAISE(ABORT, 'active worktree path or branch already belongs to a workspace') END;
        END;

        CREATE TRIGGER workspaces_unique_active_worktree_update
        BEFORE UPDATE OF worktree_path, root_path, branch, kind, status ON workspaces
        WHEN NEW.kind = 'worktree' AND NEW.status = 'active'
        BEGIN
          SELECT CASE WHEN EXISTS (
            SELECT 1 FROM workspaces
            WHERE id != NEW.id AND kind = 'worktree' AND status = 'active'
              AND (worktree_path = NEW.worktree_path OR (root_path = NEW.root_path AND branch = NEW.branch))
          ) THEN RAISE(ABORT, 'active worktree path or branch already belongs to a workspace') END;
        END;
      `)
    },
  },
  {
    id: '003-provider-session-ownership',
    apply(db) {
      db.exec(`
        UPDATE agent_sessions AS session
          SET status='failed', updated_at=datetime('now')
          WHERE session.status='running' AND session.external_id IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM agent_sessions newer
              WHERE newer.provider=session.provider
                AND newer.external_id=session.external_id
                AND newer.status='running'
                AND (newer.updated_at > session.updated_at
                  OR (newer.updated_at = session.updated_at AND newer.rowid > session.rowid))
            );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_active_provider_external
          ON agent_sessions(provider, external_id)
          WHERE external_id IS NOT NULL AND status='running';
      `)
    },
  },
  {
    id: '004-delivery-trackbook',
    apply(db) {
      db.exec(`
        ALTER TABLE task_contracts ADD COLUMN deliverables TEXT NOT NULL DEFAULT '[]';
        ALTER TABLE task_contracts ADD COLUMN non_goals TEXT NOT NULL DEFAULT '[]';
        ALTER TABLE task_contracts ADD COLUMN risks TEXT NOT NULL DEFAULT '[]';
        ALTER TABLE task_contracts ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0);

        CREATE TRIGGER task_contract_version_monotonic
        BEFORE UPDATE OF version ON task_contracts
        WHEN NEW.version < OLD.version
        BEGIN
          SELECT RAISE(ABORT, 'task contract version must increase monotonically');
        END;

        CREATE TABLE delivery_reports (
          id TEXT PRIMARY KEY,
          lineage_id TEXT NOT NULL,
          parent_report_id TEXT REFERENCES delivery_reports(id) ON DELETE RESTRICT,
          sequence INTEGER NOT NULL CHECK(sequence > 0),
          board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
          card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
          job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
          session_id TEXT REFERENCES agent_sessions(id) ON DELETE SET NULL,
          workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
          status TEXT NOT NULL DEFAULT 'draft'
            CHECK(status IN ('draft','submitted','verified','accepted','rejected')),
          asked_snapshot TEXT NOT NULL CHECK(json_valid(asked_snapshot)),
          summary TEXT NOT NULL DEFAULT '',
          delivered_items TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(delivered_items)),
          claims_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(claims_json)),
          changed_files TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(changed_files)),
          commits TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(commits)),
          artifact_ids TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(artifact_ids)),
          gaps TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(gaps)),
          created_by TEXT NOT NULL,
          submitted_by TEXT,
          verified_by TEXT,
          accepted_by TEXT,
          rejected_by TEXT,
          acceptance_note TEXT,
          rejection_reason TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          submitted_at TEXT,
          verified_at TEXT,
          accepted_at TEXT,
          rejected_at TEXT,
          CHECK((parent_report_id IS NULL AND sequence=1)
            OR (parent_report_id IS NOT NULL AND sequence>1))
        );

        CREATE TABLE delivery_deliverable_results (
          report_id TEXT NOT NULL REFERENCES delivery_reports(id) ON DELETE CASCADE,
          deliverable_id TEXT NOT NULL,
          outcome TEXT NOT NULL CHECK(outcome IN ('met','partial','missed','unverifiable')),
          note TEXT,
          evidence_refs TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(evidence_refs)),
          override_actor TEXT,
          override_reason TEXT,
          override_at TEXT,
          actor TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(report_id, deliverable_id),
          CHECK((override_actor IS NULL AND override_reason IS NULL AND override_at IS NULL)
            OR (override_actor IS NOT NULL AND override_reason IS NOT NULL AND override_at IS NOT NULL))
        );

        CREATE TABLE delivery_criterion_results (
          report_id TEXT NOT NULL REFERENCES delivery_reports(id) ON DELETE CASCADE,
          criterion_id TEXT NOT NULL,
          outcome TEXT NOT NULL CHECK(outcome IN ('met','partial','missed','unverifiable')),
          note TEXT,
          evidence_refs TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(evidence_refs)),
          override_actor TEXT,
          override_reason TEXT,
          override_at TEXT,
          actor TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(report_id, criterion_id),
          CHECK((override_actor IS NULL AND override_reason IS NULL AND override_at IS NULL)
            OR (override_actor IS NOT NULL AND override_reason IS NOT NULL AND override_at IS NOT NULL))
        );

        CREATE UNIQUE INDEX idx_delivery_reports_lineage_sequence
          ON delivery_reports(lineage_id, sequence);
        CREATE UNIQUE INDEX idx_delivery_reports_parent_revision
          ON delivery_reports(parent_report_id) WHERE parent_report_id IS NOT NULL;
        CREATE UNIQUE INDEX idx_delivery_reports_job_root
          ON delivery_reports(job_id) WHERE job_id IS NOT NULL AND parent_report_id IS NULL;
        CREATE INDEX idx_delivery_reports_card
          ON delivery_reports(card_id, created_at, sequence);
        CREATE INDEX idx_delivery_reports_status
          ON delivery_reports(board_id, status, updated_at);

        CREATE TRIGGER delivery_reports_asked_immutable
        BEFORE UPDATE OF asked_snapshot, lineage_id, parent_report_id, sequence, board_id, card_id, job_id
          ON delivery_reports
        WHEN NEW.asked_snapshot IS NOT OLD.asked_snapshot
          OR NEW.lineage_id IS NOT OLD.lineage_id
          OR NEW.parent_report_id IS NOT OLD.parent_report_id
          OR NEW.sequence IS NOT OLD.sequence
          OR NEW.board_id IS NOT OLD.board_id
          OR NEW.card_id IS NOT OLD.card_id
          OR NEW.job_id IS NOT OLD.job_id
        BEGIN
          SELECT RAISE(ABORT, 'delivery asked snapshot and lineage are immutable');
        END;

        CREATE TRIGGER delivery_reports_status_transition
        BEFORE UPDATE OF status ON delivery_reports
        WHEN NEW.status != OLD.status AND NOT (
          (OLD.status='draft' AND NEW.status='submitted')
          OR (OLD.status='submitted' AND NEW.status='verified')
          OR (OLD.status='submitted' AND NEW.status='rejected')
          OR (OLD.status='verified' AND NEW.status IN ('accepted','rejected'))
        )
        BEGIN
          SELECT RAISE(ABORT, 'invalid delivery status transition');
        END;
      `)
    },
  },
  {
    id: '005-delivery-report-revision-cascade',
    apply(db) {
      db.exec(`
        CREATE TABLE delivery_reports_v5 (
          id TEXT PRIMARY KEY,
          lineage_id TEXT NOT NULL,
          parent_report_id TEXT REFERENCES delivery_reports_v5(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
          sequence INTEGER NOT NULL CHECK(sequence > 0),
          board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
          card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
          job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
          session_id TEXT REFERENCES agent_sessions(id) ON DELETE SET NULL,
          workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
          status TEXT NOT NULL DEFAULT 'draft'
            CHECK(status IN ('draft','submitted','verified','accepted','rejected')),
          asked_snapshot TEXT NOT NULL CHECK(json_valid(asked_snapshot)),
          summary TEXT NOT NULL DEFAULT '',
          delivered_items TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(delivered_items)),
          claims_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(claims_json)),
          changed_files TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(changed_files)),
          commits TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(commits)),
          artifact_ids TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(artifact_ids)),
          gaps TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(gaps)),
          created_by TEXT NOT NULL,
          submitted_by TEXT,
          verified_by TEXT,
          accepted_by TEXT,
          rejected_by TEXT,
          acceptance_note TEXT,
          rejection_reason TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          submitted_at TEXT,
          verified_at TEXT,
          accepted_at TEXT,
          rejected_at TEXT,
          CHECK((parent_report_id IS NULL AND sequence=1)
            OR (parent_report_id IS NOT NULL AND sequence>1))
        );

        CREATE TABLE delivery_deliverable_results_v5 (
          report_id TEXT NOT NULL REFERENCES delivery_reports_v5(id) ON DELETE CASCADE,
          deliverable_id TEXT NOT NULL,
          outcome TEXT NOT NULL CHECK(outcome IN ('met','partial','missed','unverifiable')),
          note TEXT,
          evidence_refs TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(evidence_refs)),
          override_actor TEXT,
          override_reason TEXT,
          override_at TEXT,
          actor TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(report_id, deliverable_id),
          CHECK((override_actor IS NULL AND override_reason IS NULL AND override_at IS NULL)
            OR (override_actor IS NOT NULL AND override_reason IS NOT NULL AND override_at IS NOT NULL))
        );

        CREATE TABLE delivery_criterion_results_v5 (
          report_id TEXT NOT NULL REFERENCES delivery_reports_v5(id) ON DELETE CASCADE,
          criterion_id TEXT NOT NULL,
          outcome TEXT NOT NULL CHECK(outcome IN ('met','partial','missed','unverifiable')),
          note TEXT,
          evidence_refs TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(evidence_refs)),
          override_actor TEXT,
          override_reason TEXT,
          override_at TEXT,
          actor TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(report_id, criterion_id),
          CHECK((override_actor IS NULL AND override_reason IS NULL AND override_at IS NULL)
            OR (override_actor IS NOT NULL AND override_reason IS NOT NULL AND override_at IS NOT NULL))
        );

        INSERT INTO delivery_reports_v5
          (id, lineage_id, parent_report_id, sequence, board_id, card_id, job_id, session_id, workspace_id,
           status, asked_snapshot, summary, delivered_items, claims_json, changed_files, commits, artifact_ids,
           gaps, created_by, submitted_by, verified_by, accepted_by, rejected_by, acceptance_note,
           rejection_reason, created_at, updated_at, submitted_at, verified_at, accepted_at, rejected_at)
        SELECT id, lineage_id, parent_report_id, sequence, board_id, card_id, job_id, session_id, workspace_id,
          status, asked_snapshot, summary, delivered_items, claims_json, changed_files, commits, artifact_ids,
          gaps, created_by, submitted_by, verified_by, accepted_by, rejected_by, acceptance_note,
          rejection_reason, created_at, updated_at, submitted_at, verified_at, accepted_at, rejected_at
        FROM delivery_reports ORDER BY sequence, rowid;

        INSERT INTO delivery_deliverable_results_v5
          (report_id, deliverable_id, outcome, note, evidence_refs, override_actor, override_reason, override_at,
           actor, created_at, updated_at)
        SELECT report_id, deliverable_id, outcome, note, evidence_refs, override_actor, override_reason,
          override_at, actor, created_at, updated_at FROM delivery_deliverable_results;

        INSERT INTO delivery_criterion_results_v5
          (report_id, criterion_id, outcome, note, evidence_refs, override_actor, override_reason, override_at,
           actor, created_at, updated_at)
        SELECT report_id, criterion_id, outcome, note, evidence_refs, override_actor, override_reason,
          override_at, actor, created_at, updated_at FROM delivery_criterion_results;
      `)

      const deleteLeaves = db.prepare(`DELETE FROM delivery_reports
        WHERE NOT EXISTS (SELECT 1 FROM delivery_reports child WHERE child.parent_report_id=delivery_reports.id)`)
      while (deleteLeaves.run().changes > 0) { /* remove deepest revisions before RESTRICT parents */ }
      const remaining = (db.prepare('SELECT COUNT(*) AS count FROM delivery_reports').get() as { count: number }).count
      if (remaining) throw new Error('delivery report revision lineage contains a cycle')

      db.exec(`
        DROP TABLE delivery_deliverable_results;
        DROP TABLE delivery_criterion_results;
        DROP TABLE delivery_reports;
        ALTER TABLE delivery_reports_v5 RENAME TO delivery_reports;
        ALTER TABLE delivery_deliverable_results_v5 RENAME TO delivery_deliverable_results;
        ALTER TABLE delivery_criterion_results_v5 RENAME TO delivery_criterion_results;

        CREATE UNIQUE INDEX idx_delivery_reports_lineage_sequence
          ON delivery_reports(lineage_id, sequence);
        CREATE UNIQUE INDEX idx_delivery_reports_parent_revision
          ON delivery_reports(parent_report_id) WHERE parent_report_id IS NOT NULL;
        CREATE UNIQUE INDEX idx_delivery_reports_job_root
          ON delivery_reports(job_id) WHERE job_id IS NOT NULL AND parent_report_id IS NULL;
        CREATE INDEX idx_delivery_reports_card
          ON delivery_reports(card_id, created_at, sequence);
        CREATE INDEX idx_delivery_reports_status
          ON delivery_reports(board_id, status, updated_at);

        CREATE TRIGGER delivery_reports_asked_immutable
        BEFORE UPDATE OF asked_snapshot, lineage_id, parent_report_id, sequence, board_id, card_id, job_id
          ON delivery_reports
        WHEN NEW.asked_snapshot IS NOT OLD.asked_snapshot
          OR NEW.lineage_id IS NOT OLD.lineage_id
          OR NEW.parent_report_id IS NOT OLD.parent_report_id
          OR NEW.sequence IS NOT OLD.sequence
          OR NEW.board_id IS NOT OLD.board_id
          OR NEW.card_id IS NOT OLD.card_id
          OR NEW.job_id IS NOT OLD.job_id
        BEGIN
          SELECT RAISE(ABORT, 'delivery asked snapshot and lineage are immutable');
        END;

        CREATE TRIGGER delivery_reports_status_transition
        BEFORE UPDATE OF status ON delivery_reports
        WHEN NEW.status != OLD.status AND NOT (
          (OLD.status='draft' AND NEW.status='submitted')
          OR (OLD.status='submitted' AND NEW.status='verified')
          OR (OLD.status='submitted' AND NEW.status='rejected')
          OR (OLD.status='verified' AND NEW.status IN ('accepted','rejected'))
        )
        BEGIN
          SELECT RAISE(ABORT, 'invalid delivery status transition');
        END;
      `)
    },
  },
  {
    id: '006-canonical-launch-reservations',
    apply(db) {
      db.exec(`
        ALTER TABLE jobs ADD COLUMN driver_id TEXT;
        ALTER TABLE jobs ADD COLUMN effort TEXT;
        ALTER TABLE jobs ADD COLUMN access_profile TEXT NOT NULL DEFAULT 'workspace_write';
        ALTER TABLE jobs ADD COLUMN policy_id TEXT REFERENCES policies(id) ON DELETE SET NULL;
        ALTER TABLE jobs ADD COLUMN contract_version INTEGER;
        ALTER TABLE jobs ADD COLUMN idempotency_key TEXT;
        ALTER TABLE jobs ADD COLUMN request_fingerprint TEXT;

        UPDATE jobs SET driver_id=provider WHERE driver_id IS NULL;

        CREATE UNIQUE INDEX idx_jobs_board_idempotency
          ON jobs(board_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

        CREATE TABLE workspace_assignments (
          id TEXT PRIMARY KEY,
          board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
          card_id INTEGER REFERENCES cards(id) ON DELETE SET NULL,
          job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE CASCADE,
          workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          status TEXT NOT NULL DEFAULT 'reserved'
            CHECK(status IN ('reserved','active','released','failed')),
          isolation_mode TEXT NOT NULL
            CHECK(isolation_mode IN ('managed_worktree','explicit_worktree','explicit_shared')),
          access_profile TEXT NOT NULL
            CHECK(access_profile IN ('read_only','workspace_write','full_access')),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          released_at TEXT
        );

        CREATE INDEX idx_workspace_assignments_workspace
          ON workspace_assignments(workspace_id, status, created_at);
        CREATE INDEX idx_workspace_assignments_board
          ON workspace_assignments(board_id, status, created_at);

        ALTER TABLE os_events ADD COLUMN job_id TEXT;
        ALTER TABLE os_events ADD COLUMN contract_id TEXT;
        ALTER TABLE os_events ADD COLUMN correlation_id TEXT;
        ALTER TABLE os_events ADD COLUMN causation_id TEXT;
        ALTER TABLE os_events ADD COLUMN idempotency_key TEXT;
        ALTER TABLE os_events ADD COLUMN event_version INTEGER NOT NULL DEFAULT 1;

        CREATE UNIQUE INDEX idx_os_events_board_idempotency
          ON os_events(board_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
        CREATE INDEX idx_os_events_job ON os_events(job_id, created_at, id);
        CREATE INDEX idx_os_events_correlation ON os_events(correlation_id, created_at, id);
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
