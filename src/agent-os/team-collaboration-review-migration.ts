import type Database from 'better-sqlite3'

export const AGENT_OS_TEAM_COLLABORATION_REVIEW_MIGRATION_ID =
  '034-team-collaboration-review'

const DELEGATION_ADDITIONS = Object.freeze([
  ['job_id', 'TEXT REFERENCES jobs(id) ON DELETE RESTRICT'],
  ['version', 'INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1)'],
  ['updated_at', 'TEXT'],
  ['cancelled_at', 'TEXT'],
  ['transition_reason', 'TEXT'],
] as const)

const CANDIDATE_ADDITIONS = Object.freeze([
  ['reviewed_by_type', 'TEXT'],
  ['reviewed_by_id', 'TEXT'],
  ['review_reason', 'TEXT'],
  ['knowledge_source_id', 'TEXT'],
] as const)

export function installTeamCollaborationReviewSchema(db: Database.Database): void {
  assertPrerequisites(db)
  db.transaction(() => {
    addMissingColumns(db, 'os_team_delegations', DELEGATION_ADDITIONS)
    addMissingColumns(db, 'os_conflict_knowledge_candidates', CANDIDATE_ADDITIONS)
    backfillDelegationJobs(db)
    assertCandidateHistoryIsReviewable(db)
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_team_delegation_job
        ON os_team_delegations(job_id, status, updated_at);
      CREATE INDEX IF NOT EXISTS idx_conflict_knowledge_review
        ON os_conflict_knowledge_candidates(status, created_at, id);

      DROP TRIGGER IF EXISTS os_team_delegation_scope_insert;
      CREATE TRIGGER os_team_delegation_scope_insert
      BEFORE INSERT ON os_team_delegations
      WHEN NEW.job_id IS NULL OR NEW.updated_at IS NULL OR NEW.version!=1
        OR NEW.status!='assigned' OR NEW.accepted_at IS NOT NULL
        OR NEW.completed_at IS NOT NULL OR NEW.cancelled_at IS NOT NULL
        OR NEW.transition_reason IS NOT NULL
        OR NOT EXISTS (
          SELECT 1 FROM os_team_work_bindings binding
          JOIN os_team_plan_participants assignee ON assignee.id=NEW.participant_id
          JOIN os_team_plan_participants delegator ON delegator.id=NEW.delegated_by_participant_id
          JOIN jobs job ON job.id=NEW.job_id
          WHERE binding.id=NEW.binding_id
            AND binding.plan_id=NEW.plan_id
            AND binding.status='active'
            AND assignee.plan_id=NEW.plan_id AND assignee.status='active'
            AND delegator.plan_id=NEW.plan_id AND delegator.status='active'
            AND job.board_id=binding.board_id
            AND job.card_id=binding.card_id
            AND job.job_assignment_id=binding.exclusive_assignment_id
            AND job.assigned_profile_id=binding.executable_profile_id
            AND job.assignment_market_version=binding.assignment_market_version
        )
      BEGIN
        SELECT RAISE(ABORT, 'team delegation must reference its executable canonical job');
      END;

      CREATE TRIGGER IF NOT EXISTS os_team_delegation_transition_update
      BEFORE UPDATE ON os_team_delegations
      WHEN NEW.id IS NOT OLD.id
        OR NEW.binding_id IS NOT OLD.binding_id
        OR NEW.plan_id IS NOT OLD.plan_id
        OR NEW.participant_id IS NOT OLD.participant_id
        OR NEW.delegated_by_participant_id IS NOT OLD.delegated_by_participant_id
        OR NEW.contract_ref IS NOT OLD.contract_ref
        OR NEW.objective IS NOT OLD.objective
        OR NEW.criterion_ids_json IS NOT OLD.criterion_ids_json
        OR NEW.scope_paths_json IS NOT OLD.scope_paths_json
        OR NEW.job_id IS NOT OLD.job_id
        OR NEW.created_at IS NOT OLD.created_at
        OR NEW.version!=OLD.version+1
        OR NEW.updated_at IS NULL
        OR NEW.transition_reason IS NULL
        OR length(trim(NEW.transition_reason)) NOT BETWEEN 1 AND 2000
        OR NOT (
          (OLD.status='assigned' AND NEW.status IN ('accepted','cancelled'))
          OR (OLD.status='accepted' AND NEW.status IN ('completed','cancelled'))
        )
        OR (NEW.status='accepted' AND (
          NEW.accepted_at IS NULL OR NEW.completed_at IS NOT NULL OR NEW.cancelled_at IS NOT NULL
        ))
        OR (NEW.status='completed' AND (
          NEW.accepted_at IS NULL OR NEW.completed_at IS NULL OR NEW.cancelled_at IS NOT NULL
        ))
        OR (NEW.status='cancelled' AND (
          NEW.completed_at IS NOT NULL OR NEW.cancelled_at IS NULL
        ))
      BEGIN
        SELECT RAISE(ABORT, 'team delegation transition is invalid');
      END;

      CREATE TRIGGER IF NOT EXISTS os_team_delegation_delete
      BEFORE DELETE ON os_team_delegations
      BEGIN
        SELECT RAISE(ABORT, 'team delegation evidence is immutable');
      END;

      CREATE TRIGGER IF NOT EXISTS os_conflict_knowledge_candidate_insert
      BEFORE INSERT ON os_conflict_knowledge_candidates
      WHEN NEW.status!='pending_review' OR NEW.reviewed_at IS NOT NULL
        OR NEW.reviewed_by_type IS NOT NULL OR NEW.reviewed_by_id IS NOT NULL
        OR NEW.review_reason IS NOT NULL OR NEW.knowledge_source_id IS NOT NULL
      BEGIN
        SELECT RAISE(ABORT, 'conflict knowledge candidate must start pending independent review');
      END;

      CREATE TRIGGER IF NOT EXISTS os_conflict_knowledge_candidate_review_update
      BEFORE UPDATE ON os_conflict_knowledge_candidates
      WHEN NEW.id IS NOT OLD.id
        OR NEW.conflict_id IS NOT OLD.conflict_id
        OR NEW.resolution_id IS NOT OLD.resolution_id
        OR NEW.source_kind IS NOT OLD.source_kind
        OR NEW.source_ref IS NOT OLD.source_ref
        OR NEW.source_sha256 IS NOT OLD.source_sha256
        OR NEW.summary IS NOT OLD.summary
        OR NEW.requested_by_type IS NOT OLD.requested_by_type
        OR NEW.requested_by_id IS NOT OLD.requested_by_id
        OR NEW.created_at IS NOT OLD.created_at
        OR OLD.status!='pending_review'
        OR NEW.status NOT IN ('accepted','rejected')
        OR NEW.reviewed_at IS NULL
        OR NEW.reviewed_by_type IS NULL
        OR NEW.reviewed_by_id IS NULL
        OR NEW.review_reason IS NULL
        OR length(trim(NEW.review_reason)) NOT BETWEEN 1 AND 4000
        OR (NEW.status='accepted' AND (
          NEW.knowledge_source_id IS NULL
          OR length(NEW.knowledge_source_id)!=67
          OR substr(NEW.knowledge_source_id, 1, 3)!='ks_'
          OR substr(NEW.knowledge_source_id, 4) GLOB '*[^0-9a-f]*'
        ))
        OR (NEW.status='rejected' AND NEW.knowledge_source_id IS NOT NULL)
      BEGIN
        SELECT RAISE(ABORT, 'conflict knowledge review transition is invalid');
      END;

      CREATE TRIGGER IF NOT EXISTS os_conflict_knowledge_candidate_delete
      BEFORE DELETE ON os_conflict_knowledge_candidates
      BEGIN
        SELECT RAISE(ABORT, 'conflict knowledge review evidence is immutable');
      END;
    `)
  }).immediate()
}

function assertPrerequisites(db: Database.Database): void {
  const required = [
    'jobs', 'knowledge_sources', 'os_team_delegations', 'os_team_work_bindings',
    'os_team_plan_participants', 'os_conflict_knowledge_candidates', 'os_conflicts',
  ]
  const present = new Set((db.prepare(`SELECT name FROM sqlite_master
    WHERE type='table'`).all() as Array<{ name: string }>).map((row) => row.name))
  const missing = required.filter((table) => !present.has(table))
  if (missing.length) {
    throw new Error(
      `migration ${AGENT_OS_TEAM_COLLABORATION_REVIEW_MIGRATION_ID} requires ${missing.join(', ')}`,
    )
  }
}

function addMissingColumns(
  db: Database.Database,
  table: string,
  additions: readonly (readonly [string, string])[],
): void {
  const columns = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as
    Array<{ name: string }>).map((column) => column.name))
  for (const [name, definition] of additions) {
    if (!columns.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`)
  }
}

function backfillDelegationJobs(db: Database.Database): void {
  const delegations = db.prepare(`SELECT delegation.id, delegation.created_at,
      binding.board_id, binding.card_id, binding.exclusive_assignment_id,
      binding.executable_profile_id, binding.assignment_market_version
    FROM os_team_delegations delegation
    JOIN os_team_work_bindings binding ON binding.id=delegation.binding_id
    WHERE delegation.job_id IS NULL`).all() as Array<{
      id: string
      created_at: string
      board_id: number
      card_id: number
      exclusive_assignment_id: string
      executable_profile_id: string
      assignment_market_version: number
    }>
  const findJobs = db.prepare(`SELECT id FROM jobs
    WHERE board_id=? AND card_id=? AND job_assignment_id=?
      AND assigned_profile_id=? AND assignment_market_version=?
    ORDER BY id LIMIT 2`)
  const update = db.prepare(`UPDATE os_team_delegations
    SET job_id=?, updated_at=? WHERE id=? AND job_id IS NULL`)
  for (const delegation of delegations) {
    const jobs = findJobs.all(
      delegation.board_id,
      delegation.card_id,
      delegation.exclusive_assignment_id,
      delegation.executable_profile_id,
      delegation.assignment_market_version,
    ) as Array<{ id: string }>
    if (jobs.length !== 1) {
      throw new Error('existing team delegation cannot be linked to one executable canonical job')
    }
    update.run(jobs[0].id, delegation.created_at, delegation.id)
  }
  const incomplete = db.prepare(`SELECT 1 FROM os_team_delegations
    WHERE job_id IS NULL OR updated_at IS NULL LIMIT 1`).get()
  if (incomplete) throw new Error('team delegation canonical job backfill is incomplete')
}

function assertCandidateHistoryIsReviewable(db: Database.Database): void {
  const invalid = db.prepare(`SELECT 1 FROM os_conflict_knowledge_candidates
    WHERE status!='pending_review' AND (
      reviewed_at IS NULL OR reviewed_by_type IS NULL OR reviewed_by_id IS NULL
      OR review_reason IS NULL
    ) LIMIT 1`).get()
  if (invalid) throw new Error('existing conflict knowledge status lacks independent review evidence')
}
