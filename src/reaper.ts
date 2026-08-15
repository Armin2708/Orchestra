import type Database from 'better-sqlite3'

export function removeAgentCards(db: Database.Database, agentId: number): void {
  // only the agent's abandoned work-in-flight leaves with it; tickets it authored or was
  // assigned (backlog/review/blocked) outlive the agent — released to the pool, history kept
  const sel = `SELECT id FROM cards WHERE owner_agent_id=? AND column_name = 'in_progress'`
  db.prepare(`DELETE FROM card_events WHERE card_id IN (${sel})`).run(agentId)
  db.prepare(`UPDATE messages SET card_id=NULL WHERE card_id IN (${sel})`).run(agentId)
  db.prepare(`DELETE FROM cards WHERE owner_agent_id=? AND column_name = 'in_progress'`).run(agentId)
  db.prepare(`UPDATE cards SET owner_agent_id=NULL, updated_at=datetime('now')
    WHERE owner_agent_id=? AND column_name != 'done'`).run(agentId)
}

// dead-letter routing: a message to an agent that left the board would otherwise sit
// undelivered forever with the sender none the wiser — bounce it as a system reply, which
// closes the open question and lands in the sender's inbox (or the board thread when the
// sender is unknown/also gone). The bounce being a reply is also the idempotency guard.
export function bounceDeadLetters(db: Database.Database, agentId: number): any[] {
  const agent = db.prepare(`SELECT * FROM agents WHERE id=?`).get(agentId) as { name: string } | undefined
  if (!agent) return []
  const dead = db.prepare(`
    SELECT * FROM messages WHERE to_agent_id=? AND delivered_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM messages r WHERE r.reply_to = messages.id)`).all(agentId) as any[]
  const insert = db.prepare(`
    INSERT INTO messages (board_id, from_agent_id, to_agent_id, card_id, body, reply_to)
    VALUES (?, NULL, ?, ?, ?, ?)`)
  return dead.map((m) => {
    const body = `⚠ undeliverable: ${agent.name} left the board before reading msg #${m.id} — it was never seen. Re-ask a live agent or post to the board.`
    const { lastInsertRowid } = insert.run(m.board_id, m.from_agent_id, m.card_id, body, m.id)
    return db.prepare(`SELECT * FROM messages WHERE id=?`).get(Number(lastInsertRowid))
  })
}

// Needs You is a pure notification projection — resolving an item here never touches
// the live in-memory permission gate (conductor.ts's per-process `pending` map), so it's
// always safe to auto-clear. Two policies: the requesting agent is gone (nothing is
// waiting on the decision), or the item just sat open too long — hired agents stay
// 'active' between tasks indefinitely, so agent-liveness alone won't catch a request
// from a turn that ended days ago.
const ATTENTION_STALE_AFTER = '-24 hours'

export function reapAttention(db: Database.Database): void {
  db.prepare(`UPDATE attention_items SET status='resolved', resolved_at=datetime('now')
    WHERE status='open' AND agent_id IS NOT NULL
      AND agent_id IN (SELECT id FROM agents WHERE status='gone')`).run()
  db.prepare(`UPDATE attention_items SET status='resolved', resolved_at=datetime('now')
    WHERE status='open' AND created_at < datetime('now', ?)`).run(ATTENTION_STALE_AFTER)
}

export function reap(db: Database.Database): void {
  // hired agents live inside the daemon and only quiet down between tasks — they leave
  // when fired (or when resurrection fails), never by staleness
  const goners = db.prepare(`SELECT id FROM agents
    WHERE status != 'gone' AND kind != 'hired' AND last_seen < datetime('now', '-30 minutes')`).all() as { id: number }[]
  for (const g of goners) { removeAgentCards(db, g.id); bounceDeadLetters(db, g.id) }
  db.prepare(`UPDATE agents SET status='gone'
    WHERE status != 'gone' AND kind != 'hired' AND last_seen < datetime('now', '-30 minutes')`).run()
  db.prepare(`UPDATE agents SET status='idle'
    WHERE status = 'active' AND last_seen < datetime('now', '-5 minutes')`).run()
  syncAgentProfiles(db)
  reapAttention(db)
}

// Agent Home lists agent_profiles, but terminal agents live and die in the legacy agents
// table — the 022 projection only snapshotted them once, so profiles drifted from reality
// (dead agents stayed listed as active; agents registered later never appeared at all).
// Mirror liveness both ways on every reap tick. Only rows tied to a legacy agent are
// managed; user-created identities (legacy_agent_id NULL) are never touched.
export function syncAgentProfiles(db: Database.Database): void {
  const hasProfiles = db.prepare(
    `SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_profiles'`).get()
  if (!hasProfiles) return
  db.transaction(() => {
    // a mirror still driving a canonical session is not dead, whatever the legacy row says
    db.prepare(`UPDATE agent_profiles
      SET status='archived', archived_at=coalesce(archived_at, datetime('now')), updated_at=datetime('now')
      WHERE status='active'
        AND legacy_agent_id IN (SELECT id FROM agents WHERE status='gone')
        AND NOT EXISTS (SELECT 1 FROM agent_sessions s WHERE s.profile_id=agent_profiles.id
          AND s.status IN ('reserved','starting','running','idle','stopping'))`).run()

    db.prepare(`UPDATE agent_profiles
      SET status='active', archived_at=NULL, updated_at=datetime('now')
      WHERE status='archived'
        AND legacy_agent_id IN (SELECT id FROM agents WHERE status != 'gone')`).run()
    db.prepare(`UPDATE agent_conversations
      SET status='active', archived_at=NULL, updated_at=datetime('now')
      WHERE is_default=1 AND status='archived'
        AND profile_id IN (
          SELECT p.id FROM agent_profiles p JOIN agents a ON a.id=p.legacy_agent_id
          WHERE p.status='active' AND a.status != 'gone')
        AND NOT EXISTS (SELECT 1 FROM agent_conversations live
          WHERE live.profile_id=agent_conversations.profile_id
            AND live.is_default=1 AND live.status='active')`).run()

    const missing = db.prepare(`SELECT a.* FROM agents a
      LEFT JOIN agent_profiles p ON p.legacy_agent_id=a.id
      WHERE a.status != 'gone' AND p.id IS NULL`).all() as Record<string, unknown>[]
    const insertProfile = db.prepare(`INSERT INTO agent_profiles (
        id, board_id, legacy_agent_id, name, role, default_provider, default_model,
        default_effort, default_access_profile, capabilities_json, owner_actor_type,
        owner_actor_id, status, provenance_json, created_at, updated_at, archived_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', 'system', 'reaper-profile-sync',
        'active', '{"source":"legacy_agents","sync":"reaper"}', ?, ?, NULL)`)
    const insertConversation = db.prepare(`INSERT INTO agent_conversations (
        id, board_id, profile_id, title, status, is_default, next_sequence,
        created_by_actor_type, created_by_actor_id, created_at, updated_at, archived_at
      ) VALUES (?, ?, ?, ?, 'active', 1, 1, 'system', 'reaper-profile-sync', ?, ?, NULL)`)
    for (const agent of missing) {
      const agentId = Number(agent.id)
      const profileId = `legacy-agent:${agentId}`
      const conversationId = `legacy-conversation:${agentId}`
      const clash = db.prepare(`SELECT 1 FROM agent_profiles WHERE id=? OR (board_id=? AND name=?)`)
        .get(profileId, agent.board_id, agent.name)
      if (clash) continue
      const accessProfile = ['read_only', 'workspace_write', 'full_access']
        .includes(String(agent.access_profile)) ? String(agent.access_profile) : null
      insertProfile.run(
        profileId, agent.board_id, agentId, agent.name, agent.role ?? null,
        agent.provider ?? null, agent.model ?? null, agent.effort ?? null, accessProfile,
        agent.created_at, agent.last_seen)
      if (!db.prepare(`SELECT 1 FROM agent_conversations WHERE id=?`).get(conversationId)) {
        insertConversation.run(conversationId, agent.board_id, profileId,
          `${agent.name} conversation`, agent.created_at, agent.last_seen)
      }
    }
  }).immediate()
}
