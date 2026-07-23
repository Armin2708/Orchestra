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
  {
    id: '007-agent-home-domain',
    apply(db) {
      db.exec(`
        CREATE TABLE agent_profiles (
          id TEXT PRIMARY KEY,
          board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
          legacy_agent_id INTEGER UNIQUE REFERENCES agents(id) ON DELETE SET NULL,
          name TEXT NOT NULL,
          role TEXT,
          default_provider TEXT,
          default_model TEXT,
          default_effort TEXT,
          default_access_profile TEXT
            CHECK(default_access_profile IS NULL
              OR default_access_profile IN ('read_only','workspace_write','full_access')),
          capabilities_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(capabilities_json)),
          owner_actor_type TEXT NOT NULL,
          owner_actor_id TEXT,
          status TEXT NOT NULL DEFAULT 'active'
            CHECK(status IN ('active','archived')),
          provenance_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(provenance_json)),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          archived_at TEXT,
          UNIQUE(board_id, name)
        );

        CREATE TABLE agent_conversations (
          id TEXT PRIMARY KEY,
          board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
          profile_id TEXT NOT NULL REFERENCES agent_profiles(id) ON DELETE CASCADE,
          title TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active'
            CHECK(status IN ('active','archived')),
          is_default INTEGER NOT NULL DEFAULT 0 CHECK(is_default IN (0,1)),
          next_sequence INTEGER NOT NULL DEFAULT 1 CHECK(next_sequence > 0),
          created_by_actor_type TEXT NOT NULL,
          created_by_actor_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          archived_at TEXT
        );

        CREATE UNIQUE INDEX idx_agent_conversations_default
          ON agent_conversations(profile_id)
          WHERE is_default=1 AND status='active';
        CREATE INDEX idx_agent_profiles_board
          ON agent_profiles(board_id, status, name);
        CREATE INDEX idx_agent_conversations_profile
          ON agent_conversations(profile_id, status, updated_at);

        ALTER TABLE agent_sessions
          ADD COLUMN profile_id TEXT REFERENCES agent_profiles(id) ON DELETE SET NULL;
        ALTER TABLE agent_sessions
          ADD COLUMN conversation_id TEXT REFERENCES agent_conversations(id) ON DELETE SET NULL;
        ALTER TABLE agent_sessions
          ADD COLUMN job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL;
        ALTER TABLE agent_sessions
          ADD COLUMN mode TEXT NOT NULL DEFAULT 'compatibility'
            CHECK(mode IN ('managed','ambient','compatibility'));
        ALTER TABLE agent_sessions ADD COLUMN driver_id TEXT;
        ALTER TABLE agent_sessions ADD COLUMN effort TEXT;
        ALTER TABLE agent_sessions
          ADD COLUMN access_profile TEXT
            CHECK(access_profile IS NULL
              OR access_profile IN ('read_only','workspace_write','full_access'));
        ALTER TABLE agent_sessions ADD COLUMN provider_thread_id TEXT;
        ALTER TABLE agent_sessions ADD COLUMN provider_cursor TEXT;
        ALTER TABLE agent_sessions
          ADD COLUMN recovery_state TEXT NOT NULL DEFAULT 'unknown'
            CHECK(recovery_state IN ('unknown','attachable','detached','lost','unsupported'));
        ALTER TABLE agent_sessions
          ADD COLUMN recovery_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(recovery_json));
        ALTER TABLE agent_sessions
          ADD COLUMN history_state TEXT NOT NULL DEFAULT 'unavailable'
            CHECK(history_state IN ('complete','partial','unavailable'));
        ALTER TABLE agent_sessions ADD COLUMN started_at TEXT;
        ALTER TABLE agent_sessions ADD COLUMN ended_at TEXT;
        ALTER TABLE agent_sessions ADD COLUMN archived_at TEXT;

        CREATE INDEX idx_agent_sessions_profile ON agent_sessions(profile_id);
        CREATE INDEX idx_agent_sessions_conversation ON agent_sessions(conversation_id);
        CREATE INDEX idx_agent_sessions_job ON agent_sessions(job_id);

        CREATE TABLE conversation_events (
          id TEXT PRIMARY KEY,
          board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
          profile_id TEXT NOT NULL REFERENCES agent_profiles(id) ON DELETE CASCADE,
          conversation_id TEXT NOT NULL REFERENCES agent_conversations(id) ON DELETE CASCADE,
          session_id TEXT REFERENCES agent_sessions(id) ON DELETE SET NULL,
          sequence INTEGER NOT NULL CHECK(sequence > 0),
          provider TEXT,
          provider_event_id TEXT,
          provider_thread_id TEXT,
          provider_turn_id TEXT,
          provider_item_id TEXT,
          provider_cursor TEXT,
          kind TEXT NOT NULL
            CHECK(kind IN ('user','assistant','system','tool','tool_result',
              'approval','usage','status','error')),
          actor_type TEXT NOT NULL,
          actor_id TEXT,
          correlation_id TEXT,
          causation_id TEXT,
          projected_text TEXT,
          metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json)),
          raw_artifact_id TEXT REFERENCES artifacts(id) ON DELETE SET NULL,
          dedupe_key TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          redaction_state TEXT NOT NULL DEFAULT 'none'
            CHECK(redaction_state IN ('none','redacted','withheld')),
          retention_class TEXT NOT NULL DEFAULT 'transcript'
            CHECK(retention_class IN ('transcript','audit','ephemeral','pinned')),
          schema_version INTEGER NOT NULL DEFAULT 1 CHECK(schema_version > 0),
          created_at TEXT NOT NULL,
          archived_at TEXT,
          UNIQUE(conversation_id, sequence),
          UNIQUE(conversation_id, dedupe_key)
        );

        CREATE TABLE conversation_event_conflicts (
          id TEXT PRIMARY KEY,
          board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
          profile_id TEXT NOT NULL REFERENCES agent_profiles(id) ON DELETE CASCADE,
          conversation_id TEXT NOT NULL REFERENCES agent_conversations(id) ON DELETE CASCADE,
          session_id TEXT REFERENCES agent_sessions(id) ON DELETE SET NULL,
          canonical_event_id TEXT NOT NULL REFERENCES conversation_events(id) ON DELETE CASCADE,
          dedupe_key TEXT NOT NULL,
          received_content_hash TEXT NOT NULL,
          received_projected_text TEXT,
          received_metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(received_metadata_json)),
          raw_artifact_id TEXT REFERENCES artifacts(id) ON DELETE SET NULL,
          actor_type TEXT NOT NULL,
          actor_id TEXT,
          created_at TEXT NOT NULL,
          UNIQUE(canonical_event_id, received_content_hash)
        );

        CREATE INDEX idx_conversation_events_conversation
          ON conversation_events(conversation_id, sequence);
        CREATE INDEX idx_conversation_events_session
          ON conversation_events(session_id, sequence);
        CREATE INDEX idx_conversation_events_profile
          ON conversation_events(profile_id, created_at);
        CREATE INDEX idx_conversation_events_provider
          ON conversation_events(session_id, provider, provider_event_id)
          WHERE provider_event_id IS NOT NULL;
        CREATE INDEX idx_conversation_event_conflicts_event
          ON conversation_event_conflicts(canonical_event_id, created_at);

        CREATE TRIGGER agent_conversations_profile_scope_insert
        BEFORE INSERT ON agent_conversations
        BEGIN
          SELECT CASE WHEN NOT EXISTS (
            SELECT 1 FROM agent_profiles profile
            WHERE profile.id=NEW.profile_id AND profile.board_id=NEW.board_id
          ) THEN RAISE(ABORT, 'conversation profile belongs to a different board') END;
        END;

        CREATE TRIGGER agent_conversations_profile_scope_update
        BEFORE UPDATE OF board_id, profile_id ON agent_conversations
        BEGIN
          SELECT CASE WHEN NOT EXISTS (
            SELECT 1 FROM agent_profiles profile
            WHERE profile.id=NEW.profile_id AND profile.board_id=NEW.board_id
          ) THEN RAISE(ABORT, 'conversation profile belongs to a different board') END;
        END;

        CREATE TRIGGER agent_sessions_home_scope_insert
        BEFORE INSERT ON agent_sessions
        WHEN NEW.profile_id IS NOT NULL OR NEW.conversation_id IS NOT NULL
        BEGIN
          SELECT CASE WHEN NEW.profile_id IS NULL OR NEW.conversation_id IS NULL
            OR NOT EXISTS (
              SELECT 1 FROM agent_conversations conversation
              JOIN agent_profiles profile ON profile.id=conversation.profile_id
              JOIN workspaces workspace ON workspace.id=NEW.workspace_id
              WHERE conversation.id=NEW.conversation_id
                AND profile.id=NEW.profile_id
                AND profile.board_id=workspace.board_id
            )
          THEN RAISE(ABORT, 'session Agent Home scope is inconsistent') END;
        END;

        CREATE TRIGGER agent_sessions_home_scope_update
        BEFORE UPDATE OF workspace_id, profile_id, conversation_id ON agent_sessions
        WHEN NEW.profile_id IS NOT NULL OR NEW.conversation_id IS NOT NULL
        BEGIN
          SELECT CASE WHEN NEW.profile_id IS NULL OR NEW.conversation_id IS NULL
            OR NOT EXISTS (
              SELECT 1 FROM agent_conversations conversation
              JOIN agent_profiles profile ON profile.id=conversation.profile_id
              JOIN workspaces workspace ON workspace.id=NEW.workspace_id
              WHERE conversation.id=NEW.conversation_id
                AND profile.id=NEW.profile_id
                AND profile.board_id=workspace.board_id
            )
          THEN RAISE(ABORT, 'session Agent Home scope is inconsistent') END;
        END;

        CREATE TRIGGER agent_sessions_job_scope_insert
        BEFORE INSERT ON agent_sessions
        WHEN NEW.job_id IS NOT NULL
        BEGIN
          SELECT CASE WHEN NOT EXISTS (
            SELECT 1 FROM jobs job
            JOIN workspaces workspace ON workspace.id=NEW.workspace_id
            WHERE job.id=NEW.job_id
              AND job.board_id=workspace.board_id
              AND (job.workspace_id IS NULL OR job.workspace_id=NEW.workspace_id)
          ) THEN RAISE(ABORT, 'session job belongs to a different board or workspace') END;
        END;

        CREATE TRIGGER agent_sessions_job_scope_update
        BEFORE UPDATE OF workspace_id, job_id ON agent_sessions
        WHEN NEW.job_id IS NOT NULL
        BEGIN
          SELECT CASE WHEN NOT EXISTS (
            SELECT 1 FROM jobs job
            JOIN workspaces workspace ON workspace.id=NEW.workspace_id
            WHERE job.id=NEW.job_id
              AND job.board_id=workspace.board_id
              AND (job.workspace_id IS NULL OR job.workspace_id=NEW.workspace_id)
          ) THEN RAISE(ABORT, 'session job belongs to a different board or workspace') END;
        END;

        CREATE TRIGGER conversation_events_scope_insert
        BEFORE INSERT ON conversation_events
        BEGIN
          SELECT CASE WHEN NOT EXISTS (
            SELECT 1 FROM agent_conversations conversation
            JOIN agent_profiles profile ON profile.id=conversation.profile_id
            WHERE conversation.id=NEW.conversation_id
              AND conversation.board_id=NEW.board_id
              AND profile.id=NEW.profile_id
          ) THEN RAISE(ABORT, 'conversation event scope is inconsistent') END;
          SELECT CASE WHEN NEW.session_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM agent_sessions session
            WHERE session.id=NEW.session_id
              AND session.profile_id=NEW.profile_id
              AND session.conversation_id=NEW.conversation_id
          ) THEN RAISE(ABORT, 'conversation event session scope is inconsistent') END;
        END;

        CREATE TRIGGER conversation_event_conflicts_scope_insert
        BEFORE INSERT ON conversation_event_conflicts
        BEGIN
          SELECT CASE WHEN NOT EXISTS (
            SELECT 1 FROM conversation_events canonical
            WHERE canonical.id=NEW.canonical_event_id
              AND canonical.board_id=NEW.board_id
              AND canonical.profile_id=NEW.profile_id
              AND canonical.conversation_id=NEW.conversation_id
              AND canonical.dedupe_key=NEW.dedupe_key
          ) THEN RAISE(ABORT, 'conversation event conflict scope is inconsistent') END;
          SELECT CASE WHEN NEW.session_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM agent_sessions session
            WHERE session.id=NEW.session_id
              AND session.profile_id=NEW.profile_id
              AND session.conversation_id=NEW.conversation_id
          ) THEN RAISE(ABORT, 'conversation event conflict session scope is inconsistent') END;
        END;
      `)

      const hasArtifacts = !!db.prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='artifacts'",
      ).get()
      if (hasArtifacts) {
        db.exec(`
          CREATE TRIGGER conversation_events_artifact_scope_insert
          BEFORE INSERT ON conversation_events
          WHEN NEW.raw_artifact_id IS NOT NULL
          BEGIN
            SELECT CASE WHEN NOT EXISTS (
              SELECT 1 FROM artifacts artifact
              WHERE artifact.id=NEW.raw_artifact_id
                AND artifact.board_id=NEW.board_id
                AND (
                  artifact.workspace_id IS NULL
                  OR EXISTS (
                    SELECT 1 FROM agent_sessions session
                    WHERE session.id=NEW.session_id
                      AND session.workspace_id=artifact.workspace_id
                  )
                )
            ) THEN RAISE(ABORT, 'conversation event artifact scope is inconsistent') END;
          END;

          CREATE TRIGGER conversation_event_conflicts_artifact_scope_insert
          BEFORE INSERT ON conversation_event_conflicts
          WHEN NEW.raw_artifact_id IS NOT NULL
          BEGIN
            SELECT CASE WHEN NOT EXISTS (
              SELECT 1 FROM artifacts artifact
              WHERE artifact.id=NEW.raw_artifact_id
                AND artifact.board_id=NEW.board_id
                AND (
                  artifact.workspace_id IS NULL
                  OR EXISTS (
                    SELECT 1 FROM agent_sessions session
                    WHERE session.id=NEW.session_id
                      AND session.workspace_id=artifact.workspace_id
                  )
                )
            ) THEN RAISE(ABORT, 'conversation event conflict artifact scope is inconsistent') END;
          END;
        `)
      }

      const hasLegacyAgents = !!db.prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='agents'",
      ).get()
      const sessionColumns = new Set(
        (db.prepare("PRAGMA table_info('agent_sessions')").all() as Array<{ name: string }>)
          .map((column) => column.name),
      )
      if (!hasLegacyAgents || !sessionColumns.has('agent_id')) return

      db.exec(`
        INSERT OR IGNORE INTO agent_profiles (
          id, board_id, legacy_agent_id, name, role, default_provider, default_model,
          default_effort, default_access_profile, capabilities_json, owner_actor_type,
          owner_actor_id, status, provenance_json, created_at, updated_at, archived_at
        )
        SELECT
          'legacy-agent:' || agent.id,
          agent.board_id,
          agent.id,
          agent.name,
          agent.role,
          CASE WHEN trim(coalesce(agent.provider, ''))='' THEN NULL ELSE agent.provider END,
          agent.model,
          agent.effort,
          CASE WHEN agent.access_profile IN ('read_only','workspace_write','full_access')
            THEN agent.access_profile ELSE NULL END,
          '[]',
          'operator',
          NULL,
          'active',
          json_object(
            'source', 'legacy_agents',
            'legacy_kind', coalesce(agent.kind, 'session'),
            'legacy_status', coalesce(agent.status, 'unknown')
          ),
          agent.created_at,
          agent.last_seen,
          NULL
        FROM agents agent;

        INSERT OR IGNORE INTO agent_conversations (
          id, board_id, profile_id, title, status, is_default, next_sequence,
          created_by_actor_type, created_by_actor_id, created_at, updated_at, archived_at
        )
        SELECT
          'legacy-conversation:' || agent.id,
          agent.board_id,
          'legacy-agent:' || agent.id,
          agent.name || ' conversation',
          'active',
          1,
          1,
          'migration',
          '007-agent-home-domain',
          agent.created_at,
          agent.last_seen,
          NULL
        FROM agents agent
        JOIN agent_profiles profile ON profile.id='legacy-agent:' || agent.id;

        UPDATE agent_sessions
        SET profile_id='legacy-agent:' || agent_id,
            conversation_id='legacy-conversation:' || agent_id
        WHERE agent_id IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM agent_profiles profile
            JOIN workspaces workspace ON workspace.id=agent_sessions.workspace_id
            WHERE profile.id='legacy-agent:' || agent_sessions.agent_id
              AND profile.board_id=workspace.board_id
          );

        UPDATE agent_sessions
        SET status='lost',
            mode='compatibility',
            driver_id=CASE
              WHEN json_valid(context_json)
                AND json_type(context_json, '$.driver_id')='text'
              THEN json_extract(context_json, '$.driver_id')
              ELSE coalesce(driver_id, provider)
            END,
            effort=CASE
              WHEN json_valid(context_json)
                AND json_type(context_json, '$.effort')='text'
              THEN json_extract(context_json, '$.effort')
              ELSE effort
            END,
            access_profile=CASE
              WHEN json_valid(context_json)
                AND json_extract(context_json, '$.access_profile')
                  IN ('read_only','workspace_write','full_access')
              THEN json_extract(context_json, '$.access_profile')
              ELSE access_profile
            END,
            provider_thread_id=coalesce(provider_thread_id, external_id),
            provider_cursor=CASE
              WHEN json_valid(context_json)
                AND json_type(context_json, '$.last_event_seq') IN ('integer','text')
              THEN CAST(json_extract(context_json, '$.last_event_seq') AS TEXT)
              ELSE provider_cursor
            END,
            recovery_state='lost',
            recovery_json=json_object(
              'source', 'legacy_backfill',
              'reason', 'agent_workspace_board_mismatch'
            ),
            history_state='unavailable',
            started_at=coalesce(started_at, created_at),
            ended_at=coalesce(ended_at, updated_at)
        WHERE agent_id IS NOT NULL
          AND profile_id IS NULL
          AND EXISTS (
            SELECT 1 FROM agents agent
            JOIN workspaces workspace ON workspace.id=agent_sessions.workspace_id
            WHERE agent.id=agent_sessions.agent_id
              AND agent.board_id!=workspace.board_id
          );

        UPDATE agent_sessions
        SET job_id=json_extract(context_json, '$.job_id')
        WHERE json_valid(context_json)
          AND json_type(context_json, '$.job_id')='text'
          AND EXISTS (
            SELECT 1 FROM jobs job
            JOIN workspaces workspace ON workspace.id=agent_sessions.workspace_id
            WHERE job.id=json_extract(agent_sessions.context_json, '$.job_id')
              AND job.board_id=workspace.board_id
              AND (job.workspace_id IS NULL OR job.workspace_id=agent_sessions.workspace_id)
          );

        UPDATE agent_sessions
        SET driver_id=CASE
              WHEN json_valid(context_json)
                AND json_type(context_json, '$.driver_id')='text'
              THEN json_extract(context_json, '$.driver_id')
              ELSE provider
            END,
            effort=CASE
              WHEN json_valid(context_json)
                AND json_type(context_json, '$.effort')='text'
              THEN json_extract(context_json, '$.effort')
              ELSE effort
            END,
            access_profile=CASE
              WHEN json_valid(context_json)
                AND json_extract(context_json, '$.access_profile')
                  IN ('read_only','workspace_write','full_access')
              THEN json_extract(context_json, '$.access_profile')
              ELSE access_profile
            END,
            provider_thread_id=external_id,
            provider_cursor=CASE
              WHEN json_valid(context_json)
                AND json_type(context_json, '$.last_event_seq') IN ('integer','text')
              THEN CAST(json_extract(context_json, '$.last_event_seq') AS TEXT)
              ELSE NULL
            END,
            mode=CASE
              WHEN job_id IS NOT NULL THEN 'managed'
              WHEN EXISTS (
                SELECT 1 FROM agents agent
                WHERE agent.id=agent_sessions.agent_id AND agent.kind='session'
              ) THEN 'ambient'
              ELSE 'compatibility'
            END,
            recovery_state=CASE
              WHEN status='lost' THEN 'lost'
              WHEN external_id IS NOT NULL THEN 'attachable'
              ELSE 'unknown'
            END,
            recovery_json=json_object('source', 'legacy_backfill'),
            history_state=CASE WHEN EXISTS (
              SELECT 1 FROM os_events event
              WHERE event.session_id=agent_sessions.id AND event.kind LIKE 'driver.%'
            ) THEN 'partial' ELSE 'unavailable' END,
            started_at=created_at,
            ended_at=CASE WHEN status IN ('stopped','failed','lost') THEN updated_at ELSE NULL END
        WHERE profile_id IS NOT NULL AND conversation_id IS NOT NULL;
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
