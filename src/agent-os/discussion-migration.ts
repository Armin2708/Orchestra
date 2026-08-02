import type Database from 'better-sqlite3'

export const AGENT_OS_DISCUSSION_MIGRATION_ID = '032-discussions-domain'

export const AGENT_OS_DISCUSSION_TABLES = Object.freeze([
  'os_discussions',
  'os_discussion_posts',
  'os_discussion_tags',
  'os_discussion_links',
  'os_discussion_mentions',
  'os_discussion_subscriptions',
  'os_discussion_permissions',
  'os_discussion_notifications',
  'os_discussion_promotions',
  'os_discussion_events',
  'os_discussion_commands',
] as const)

const TABLE_COLUMNS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  os_discussions: [
    'id', 'board_id', 'discussion_type', 'state', 'title', 'body',
    'created_by_type', 'created_by_id', 'created_by_profile_id',
    'accepted_post_id', 'resolution_summary', 'superseded_by_id',
    'version', 'created_at', 'updated_at', 'resolved_at', 'archived_at',
  ],
  os_discussion_posts: [
    'id', 'discussion_id', 'parent_post_id', 'post_kind', 'body',
    'content_sha256', 'author_type', 'author_id', 'author_profile_id',
    'provider', 'session_id', 'automated', 'requested_action', 'reply_depth',
    'version', 'created_at', 'updated_at', 'edited_at',
  ],
  os_discussion_tags: ['discussion_id', 'tag', 'created_at'],
  os_discussion_links: [
    'id', 'discussion_id', 'link_type', 'target_id', 'target_path',
    'symbol_name', 'source_revision', 'source_sha256', 'created_at',
  ],
  os_discussion_mentions: [
    'post_id', 'profile_id', 'mention_kind', 'created_at',
  ],
  os_discussion_subscriptions: [
    'discussion_id', 'profile_id', 'created_by_type', 'created_by_id',
    'created_at',
  ],
  os_discussion_permissions: [
    'id', 'board_id', 'discussion_id', 'subject_type', 'subject_id',
    'permission', 'granted_by_type', 'granted_by_id', 'reason',
    'expires_at', 'created_at', 'revoked_at',
  ],
  os_discussion_notifications: [
    'id', 'discussion_id', 'post_id', 'recipient_profile_id', 'reason',
    'causation_event_id', 'status', 'attempt_count', 'last_error_code',
    'created_at', 'delivered_at',
  ],
  os_discussion_promotions: [
    'id', 'discussion_id', 'post_id', 'status', 'source_uri',
    'source_content_sha256', 'artifact_json', 'artifact_sha256',
    'acceptance_event_id', 'requested_by_type', 'requested_by_id',
    'reviewed_by_type', 'reviewed_by_id', 'review_note',
    'knowledge_result_json', 'created_at', 'reviewed_at', 'promoted_at',
  ],
  os_discussion_events: [
    'id', 'board_id', 'discussion_id', 'post_id', 'event_type',
    'event_version', 'actor_type', 'actor_id', 'actor_profile_id',
    'correlation_id', 'causation_id', 'idempotency_key', 'payload_json',
    'created_at',
  ],
  os_discussion_commands: [
    'board_id', 'idempotency_key', 'command_type', 'fingerprint_sha256',
    'result_kind', 'result_id', 'created_at',
  ],
})

/**
 * Installs the isolated Discussion schema. The central migration ledger owns
 * ordering and calls this function; this module never mutates that ledger.
 */
export function installDiscussionSchema(db: Database.Database): void {
  assertExistingTablesCompatible(db)
  db.exec(`
    CREATE TABLE IF NOT EXISTS os_discussions (
      id TEXT PRIMARY KEY,
      board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
      discussion_type TEXT NOT NULL CHECK (discussion_type IN (
        'question','answer','plan','decision','announcement','conflict'
      )),
      state TEXT NOT NULL CHECK (state IN (
        'open','answered','resolved','needs_human','archived','superseded'
      )),
      title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 500),
      body TEXT NOT NULL CHECK (length(trim(body)) BETWEEN 1 AND 200000),
      created_by_type TEXT NOT NULL CHECK (created_by_type IN ('operator','agent','service')),
      created_by_id TEXT NOT NULL,
      created_by_profile_id TEXT REFERENCES agent_profiles(id) ON DELETE RESTRICT,
      accepted_post_id TEXT,
      resolution_summary TEXT,
      superseded_by_id TEXT REFERENCES os_discussions(id) ON DELETE RESTRICT,
      version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      resolved_at TEXT,
      archived_at TEXT,
      FOREIGN KEY (accepted_post_id) REFERENCES os_discussion_posts(id) ON DELETE RESTRICT,
      CHECK (resolution_summary IS NULL OR length(trim(resolution_summary)) BETWEEN 1 AND 20000),
      CHECK ((state='resolved') = (resolved_at IS NOT NULL)),
      CHECK ((state IN ('archived','superseded')) = (archived_at IS NOT NULL)),
      CHECK ((state='superseded') = (superseded_by_id IS NOT NULL))
    );

    CREATE TABLE IF NOT EXISTS os_discussion_posts (
      id TEXT PRIMARY KEY,
      discussion_id TEXT NOT NULL REFERENCES os_discussions(id) ON DELETE CASCADE,
      parent_post_id TEXT REFERENCES os_discussion_posts(id) ON DELETE RESTRICT,
      post_kind TEXT NOT NULL CHECK (post_kind IN (
        'question','answer','plan','decision','announcement','conflict','comment','resolution'
      )),
      body TEXT NOT NULL CHECK (length(trim(body)) BETWEEN 1 AND 200000),
      content_sha256 TEXT NOT NULL CHECK (
        length(content_sha256)=64 AND content_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      author_type TEXT NOT NULL CHECK (author_type IN ('operator','agent','service')),
      author_id TEXT NOT NULL,
      author_profile_id TEXT REFERENCES agent_profiles(id) ON DELETE RESTRICT,
      provider TEXT,
      session_id TEXT REFERENCES agent_sessions(id) ON DELETE RESTRICT,
      automated INTEGER NOT NULL DEFAULT 0 CHECK (automated IN (0,1)),
      requested_action TEXT,
      reply_depth INTEGER NOT NULL CHECK (reply_depth BETWEEN 0 AND 1024),
      version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      edited_at TEXT,
      CHECK (parent_post_id IS NULL OR parent_post_id != id),
      CHECK (requested_action IS NULL OR length(trim(requested_action)) BETWEEN 1 AND 4000),
      CHECK ((version=1) = (edited_at IS NULL))
    );

    CREATE TABLE IF NOT EXISTS os_discussion_tags (
      discussion_id TEXT NOT NULL REFERENCES os_discussions(id) ON DELETE CASCADE,
      tag TEXT NOT NULL CHECK (length(tag) BETWEEN 1 AND 80 AND tag=lower(trim(tag))),
      created_at TEXT NOT NULL,
      PRIMARY KEY (discussion_id, tag)
    );

    CREATE TABLE IF NOT EXISTS os_discussion_links (
      id TEXT PRIMARY KEY,
      discussion_id TEXT NOT NULL REFERENCES os_discussions(id) ON DELETE CASCADE,
      link_type TEXT NOT NULL CHECK (link_type IN (
        'repo','job','contract','agent','workspace','file','symbol','delivery'
      )),
      target_id TEXT,
      target_path TEXT,
      symbol_name TEXT,
      source_revision TEXT,
      source_sha256 TEXT CHECK (
        source_sha256 IS NULL OR (
          length(source_sha256)=64 AND source_sha256 NOT GLOB '*[^0-9a-f]*'
        )
      ),
      created_at TEXT NOT NULL,
      CHECK (target_id IS NOT NULL OR target_path IS NOT NULL),
      CHECK (link_type='symbol' OR symbol_name IS NULL),
      UNIQUE (discussion_id, link_type, target_id, target_path, symbol_name)
    );

    CREATE TABLE IF NOT EXISTS os_discussion_mentions (
      post_id TEXT NOT NULL REFERENCES os_discussion_posts(id) ON DELETE CASCADE,
      profile_id TEXT NOT NULL REFERENCES agent_profiles(id) ON DELETE RESTRICT,
      mention_kind TEXT NOT NULL CHECK (mention_kind IN ('explicit','assignee','reviewer')),
      created_at TEXT NOT NULL,
      PRIMARY KEY (post_id, profile_id)
    );

    CREATE TABLE IF NOT EXISTS os_discussion_subscriptions (
      discussion_id TEXT NOT NULL REFERENCES os_discussions(id) ON DELETE CASCADE,
      profile_id TEXT NOT NULL REFERENCES agent_profiles(id) ON DELETE RESTRICT,
      created_by_type TEXT NOT NULL CHECK (created_by_type IN ('operator','agent','service')),
      created_by_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (discussion_id, profile_id)
    );

    CREATE TABLE IF NOT EXISTS os_discussion_permissions (
      id TEXT PRIMARY KEY,
      board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
      discussion_id TEXT REFERENCES os_discussions(id) ON DELETE CASCADE,
      subject_type TEXT NOT NULL CHECK (subject_type IN ('operator','profile','service')),
      subject_id TEXT NOT NULL,
      permission TEXT NOT NULL CHECK (permission IN (
        'edit','resolve','moderate','promote_knowledge'
      )),
      granted_by_type TEXT NOT NULL CHECK (granted_by_type IN ('operator','service')),
      granted_by_id TEXT NOT NULL,
      reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 2000),
      expires_at TEXT,
      created_at TEXT NOT NULL,
      revoked_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_discussion_permissions_active
      ON os_discussion_permissions(
        board_id, coalesce(discussion_id, ''), subject_type, subject_id, permission
      ) WHERE revoked_at IS NULL;

    CREATE TABLE IF NOT EXISTS os_discussion_notifications (
      id TEXT PRIMARY KEY,
      discussion_id TEXT NOT NULL REFERENCES os_discussions(id) ON DELETE CASCADE,
      post_id TEXT NOT NULL REFERENCES os_discussion_posts(id) ON DELETE CASCADE,
      recipient_profile_id TEXT NOT NULL REFERENCES agent_profiles(id) ON DELETE RESTRICT,
      reason TEXT NOT NULL CHECK (reason IN ('mention','subscription','direct_reply')),
      causation_event_id TEXT NOT NULL REFERENCES os_discussion_events(id) ON DELETE RESTRICT,
      status TEXT NOT NULL CHECK (status IN (
        'pending','delivering','delivered','failed','suppressed'
      )),
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 10),
      last_error_code TEXT,
      created_at TEXT NOT NULL,
      delivered_at TEXT,
      UNIQUE (post_id, recipient_profile_id),
      CHECK ((status='delivered') = (delivered_at IS NOT NULL))
    );

    CREATE TABLE IF NOT EXISTS os_discussion_promotions (
      id TEXT PRIMARY KEY,
      discussion_id TEXT NOT NULL REFERENCES os_discussions(id) ON DELETE RESTRICT,
      post_id TEXT NOT NULL REFERENCES os_discussion_posts(id) ON DELETE RESTRICT,
      status TEXT NOT NULL CHECK (status IN (
        'pending_review','approved','promoting','promoted','rejected','failed'
      )),
      source_uri TEXT NOT NULL,
      source_content_sha256 TEXT NOT NULL CHECK (
        length(source_content_sha256)=64
        AND source_content_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      artifact_json TEXT NOT NULL CHECK (json_valid(artifact_json)),
      artifact_sha256 TEXT NOT NULL CHECK (
        length(artifact_sha256)=64 AND artifact_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      acceptance_event_id TEXT NOT NULL REFERENCES os_discussion_events(id) ON DELETE RESTRICT,
      requested_by_type TEXT NOT NULL CHECK (requested_by_type IN ('operator','agent','service')),
      requested_by_id TEXT NOT NULL,
      reviewed_by_type TEXT,
      reviewed_by_id TEXT,
      review_note TEXT,
      knowledge_result_json TEXT CHECK (
        knowledge_result_json IS NULL OR json_valid(knowledge_result_json)
      ),
      created_at TEXT NOT NULL,
      reviewed_at TEXT,
      promoted_at TEXT,
      UNIQUE (discussion_id, post_id, source_content_sha256),
      CHECK ((status='pending_review') = (reviewed_at IS NULL)),
      CHECK ((status='promoted') = (promoted_at IS NOT NULL))
    );

    CREATE TABLE IF NOT EXISTS os_discussion_events (
      id TEXT PRIMARY KEY,
      board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
      discussion_id TEXT NOT NULL REFERENCES os_discussions(id) ON DELETE CASCADE,
      post_id TEXT REFERENCES os_discussion_posts(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      event_version INTEGER NOT NULL DEFAULT 1 CHECK (event_version=1),
      actor_type TEXT NOT NULL CHECK (actor_type IN ('operator','agent','service')),
      actor_id TEXT NOT NULL,
      actor_profile_id TEXT REFERENCES agent_profiles(id) ON DELETE RESTRICT,
      correlation_id TEXT NOT NULL,
      causation_id TEXT,
      idempotency_key TEXT NOT NULL,
      payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
      created_at TEXT NOT NULL,
      UNIQUE (board_id, idempotency_key)
    );

    CREATE TABLE IF NOT EXISTS os_discussion_commands (
      board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
      idempotency_key TEXT NOT NULL,
      command_type TEXT NOT NULL,
      fingerprint_sha256 TEXT NOT NULL CHECK (
        length(fingerprint_sha256)=64 AND fingerprint_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      result_kind TEXT NOT NULL,
      result_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (board_id, idempotency_key)
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS os_discussion_search USING fts5(
      discussion_id UNINDEXED,
      post_id UNINDEXED,
      board_id UNINDEXED,
      title,
      body,
      tags,
      tokenize='unicode61 remove_diacritics 2'
    );

    CREATE INDEX IF NOT EXISTS idx_discussions_board_queue
      ON os_discussions(board_id, state, discussion_type, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_discussion_posts_tree
      ON os_discussion_posts(discussion_id, parent_post_id, created_at, id);
    CREATE INDEX IF NOT EXISTS idx_discussion_posts_author
      ON os_discussion_posts(author_profile_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_discussion_links_target
      ON os_discussion_links(link_type, target_id, target_path);
    CREATE INDEX IF NOT EXISTS idx_discussion_notifications_queue
      ON os_discussion_notifications(status, recipient_profile_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_discussion_events_correlation
      ON os_discussion_events(correlation_id, created_at, id);
    CREATE INDEX IF NOT EXISTS idx_discussion_promotions_queue
      ON os_discussion_promotions(status, created_at);

    CREATE TRIGGER IF NOT EXISTS os_discussion_posts_parent_scope_insert
    BEFORE INSERT ON os_discussion_posts
    WHEN NEW.parent_post_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM os_discussion_posts parent
      WHERE parent.id=NEW.parent_post_id
        AND parent.discussion_id=NEW.discussion_id
        AND parent.reply_depth + 1=NEW.reply_depth
    )
    BEGIN
      SELECT RAISE(ABORT, 'discussion post parent scope mismatch');
    END;

    CREATE TRIGGER IF NOT EXISTS os_discussion_posts_identity_immutable
    BEFORE UPDATE ON os_discussion_posts
    WHEN NEW.id!=OLD.id OR NEW.discussion_id!=OLD.discussion_id
      OR NEW.parent_post_id IS NOT OLD.parent_post_id
      OR NEW.author_type!=OLD.author_type OR NEW.author_id!=OLD.author_id
      OR NEW.author_profile_id IS NOT OLD.author_profile_id
      OR NEW.provider IS NOT OLD.provider OR NEW.session_id IS NOT OLD.session_id
      OR NEW.automated!=OLD.automated OR NEW.reply_depth!=OLD.reply_depth
    BEGIN
      SELECT RAISE(ABORT, 'discussion post identity is immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS os_discussions_identity_immutable
    BEFORE UPDATE ON os_discussions
    WHEN NEW.id!=OLD.id OR NEW.board_id!=OLD.board_id
      OR NEW.discussion_type!=OLD.discussion_type
      OR NEW.created_by_type!=OLD.created_by_type
      OR NEW.created_by_id!=OLD.created_by_id
      OR NEW.created_by_profile_id IS NOT OLD.created_by_profile_id
      OR NEW.created_at!=OLD.created_at
    BEGIN
      SELECT RAISE(ABORT, 'discussion identity is immutable');
    END;
  `)
}

function assertExistingTablesCompatible(db: Database.Database): void {
  for (const [table, expected] of Object.entries(TABLE_COLUMNS)) {
    const exists = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`)
      .get(table)
    if (!exists) continue
    const actual = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
      .map((column) => column.name)
    if (actual.join('\u0000') !== expected.join('\u0000')) {
      throw new Error(
        `migration ${AGENT_OS_DISCUSSION_MIGRATION_ID} found incompatible table ${table}`,
      )
    }
  }
}
