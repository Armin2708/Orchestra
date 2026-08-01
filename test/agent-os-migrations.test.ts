import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { openDb } from '../src/db.js'
import { applyAgentOsMigrations } from '../src/agent-os/migrations.js'
import { AgentProfileService } from '../src/agent-os/agent-profiles.js'
import { canonicalHash, stableJson } from '../src/agent-os/agent-home-support.js'
import { ArtifactStore } from '../src/agent-os/artifact-store.js'
import { ConversationService } from '../src/agent-os/conversations.js'
import { EventStore } from '../src/agent-os/event-store.js'
import { JobAssignmentService } from '../src/agent-os/job-assignments.js'
import { TaskContractService } from '../src/agent-os/task-contracts.js'

const tempDirs: string[] = []
afterEach(() => {
  for (const directory of tempDirs.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

function installLegacyCompatibilityFixtureTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id INTEGER PRIMARY KEY,
      board_id INTEGER NOT NULL REFERENCES boards(id),
      name TEXT NOT NULL,
      role TEXT,
      provider TEXT NOT NULL DEFAULT 'claude',
      model TEXT,
      effort TEXT,
      access_profile TEXT,
      kind TEXT NOT NULL DEFAULT 'session',
      status TEXT NOT NULL DEFAULT 'active',
      last_seen TEXT NOT NULL DEFAULT (datetime('now')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
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
      title TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ideas (
      id INTEGER PRIMARY KEY,
      board_id INTEGER NOT NULL REFERENCES boards(id),
      text TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS deliveries (
      message_id INTEGER NOT NULL,
      agent_id INTEGER NOT NULL,
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
      PRIMARY KEY (board_id, agent_id, day)
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY,
      board_id INTEGER NOT NULL REFERENCES boards(id),
      kind TEXT NOT NULL DEFAULT 'ask',
      body TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS message_targets (
      message_id INTEGER NOT NULL,
      agent_id INTEGER NOT NULL,
      PRIMARY KEY (message_id, agent_id)
    );
  `)
}

describe('Agent OS migrations', () => {
  it('does not record migration 009 when its prerequisite tables are absent', () => {
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE os_schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO os_schema_migrations (id) VALUES
        ('001-agent-os-kernel'), ('002-runtime-hardening'),
        ('003-provider-session-ownership'), ('004-delivery-trackbook'),
        ('005-delivery-report-revision-cascade'), ('006-canonical-launch-reservations'),
        ('007-agent-home-domain'), ('008-agent-home-controls');
    `)

    expect(() => applyAgentOsMigrations(db))
      .toThrow(/009-job-market-domain requires cards and task_contracts/)
    expect(db.prepare(`SELECT COUNT(*) AS count FROM os_schema_migrations
      WHERE id='009-job-market-domain'`).get()).toEqual({ count: 0 })
    expect(db.prepare(`SELECT COUNT(*) AS count FROM sqlite_master
      WHERE type='table' AND name LIKE 'job_market_%'`).get()).toEqual({ count: 0 })
    db.close()
  })

  it('creates the kernel schema exactly once across repeated opens', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-os-schema-'))
    tempDirs.push(directory)
    const file = path.join(directory, 'orchestra.db')
    const first = openDb(file)
    applyAgentOsMigrations(first)
    expect((first.prepare('SELECT COUNT(*) AS count FROM os_schema_migrations').get() as any).count).toBe(26)
    first.close()

    const second = openDb(file)
    const tables = new Set((second.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as any[]).map((row) => row.name))
    for (const table of ['workspaces', 'agent_sessions', 'processes', 'process_output', 'os_events', 'artifacts',
      'policies', 'task_contracts', 'attention_items', 'checkpoints', 'jobs', 'context_items', 'daemon_leases',
      'delivery_reports', 'delivery_deliverable_results', 'delivery_criterion_results', 'workspace_assignments',
      'agent_profiles', 'agent_conversations', 'conversation_events',
      'conversation_event_conflicts', 'agent_session_actions',
      'agent_session_action_reconciliations',
      'job_market_contracts', 'job_market_criteria',
      'job_market_dependencies', 'job_market_assignments', 'agent_home_retention_policies',
      'agent_home_retention_runs', 'agent_home_raw_artifact_archives',
      'agent_home_evidence_bundle_repairs', 'agent_home_transcript_repairs',
      'knowledge_sources', 'knowledge_chunks', 'context_builds',
      'context_build_sources', 'context_build_entries', 'context_uses',
      'provider_acceptance_evidence', 'os_compatibility_projection_links',
      'os_compatibility_projection_quarantine',
      'os_compatibility_migration_checks']) {
      expect(tables.has(table), table).toBe(true)
    }
    expect((second.prepare('SELECT COUNT(*) AS count FROM os_schema_migrations').get() as any).count).toBe(26)
    const migrationIds = (second.prepare(
      'SELECT id FROM os_schema_migrations ORDER BY rowid',
    ).all() as Array<{ id: string }>).map((row) => row.id)
    expect(migrationIds.slice(-15)).toEqual([
      '012-agent-home-retention',
      '013-agent-home-structured-metadata-redaction',
      '014-agent-home-native-fork-lifecycle',
      '015-agent-home-action-command-scope',
      '016-job-market-assignment-lifecycle',
      '017-job-assignment-runtime-binding',
      '018-knowledge-persistence',
      '019-provider-acceptance-evidence',
      '020-causal-event-metadata',
      '021-command-idempotency-coverage',
      '022-legacy-projection-forward-plan',
      '023-compatibility-migration-telemetry',
      '024-compatibility-migration-failure-journal',
      '025-knowledge-retrieval',
      '026-job-agent-brief',
    ])
    expect(migrationIds.at(-1))
      .toBe('026-job-agent-brief')
    expect(migrationIds).not.toContain('013-agent-home-native-fork')
    expect((second.prepare("SELECT dflt_value FROM pragma_table_info('workspaces') WHERE name='status'").get() as any).dflt_value)
      .toBe("'active'")
    expect((second.prepare("SELECT dflt_value FROM pragma_table_info('processes') WHERE name='recipe_json'").get() as any).dflt_value)
      .toBe("'{}'")
    expect((second.prepare("SELECT dflt_value FROM pragma_table_info('jobs') WHERE name='spent_tokens'").get() as any).dflt_value)
      .toBe('0')
    expect((second.prepare("SELECT dflt_value FROM pragma_table_info('task_contracts') WHERE name='version'").get() as any).dflt_value)
      .toBe('1')
    expect(second.prepare(`SELECT name, dflt_value, "notnull" AS required
      FROM pragma_table_info('agent_session_actions')
      WHERE name IN ('reserved_session_id','effect_state','effect_json')
      ORDER BY name`).all()).toEqual([
      { name: 'effect_json', dflt_value: "'{}'", required: 1 },
      { name: 'effect_state', dflt_value: "'reserved'", required: 1 },
      { name: 'reserved_session_id', dflt_value: null, required: 0 },
    ])
    second.prepare("INSERT INTO boards (id, project_path, name) VALUES (1, '/provider-ownership', 'ownership')").run()
    second.prepare(`INSERT INTO workspaces
      (id, board_id, name, kind, root_path, base_ref) VALUES ('w1', 1, 'one', 'shared', '/provider-ownership', 'HEAD')`).run()
    second.prepare(`INSERT INTO workspaces
      (id, board_id, name, kind, root_path, base_ref) VALUES ('w2', 1, 'two', 'shared', '/provider-ownership', 'HEAD')`).run()
    second.prepare(`INSERT INTO agent_sessions
      (id, workspace_id, provider, external_id, status) VALUES ('s1', 'w1', 'codex', 'thread-1', 'running')`).run()
    expect(second.prepare('SELECT control_state FROM agent_sessions WHERE id=?').get('s1'))
      .toEqual({ control_state: 'active' })
    second.prepare("UPDATE agent_sessions SET status='failed' WHERE id='s1'").run()
    expect(second.prepare('SELECT control_state FROM agent_sessions WHERE id=?').get('s1'))
      .toEqual({ control_state: 'stopped' })
    second.prepare("UPDATE agent_sessions SET status='running' WHERE id='s1'").run()
    expect(second.prepare('SELECT control_state FROM agent_sessions WHERE id=?').get('s1'))
      .toEqual({ control_state: 'active' })
    expect(() => second.prepare(`INSERT INTO agent_sessions
      (id, workspace_id, provider, external_id, status) VALUES ('s2', 'w2', 'codex', 'thread-1', 'running')`).run())
      .toThrow(/UNIQUE/)
    expect(() => second.prepare(`INSERT INTO agent_sessions
      (id, workspace_id, provider, external_id, status) VALUES ('s3', 'w2', 'codex', 'thread-1', 'stopped')`).run())
      .not.toThrow()
    second.close()
  })

  it('can safely rerun migration 012 after its marker is removed', () => {
    const db = openDb(':memory:')
    db.prepare("DELETE FROM os_schema_migrations WHERE id='012-agent-home-retention'").run()

    expect(() => applyAgentOsMigrations(db)).not.toThrow()
    expect((db.prepare(`SELECT COUNT(*) AS count FROM os_schema_migrations
      WHERE id='012-agent-home-retention'`).get() as { count: number }).count).toBe(1)
    expect((db.prepare('SELECT COUNT(*) AS count FROM os_schema_migrations').get() as {
      count: number
    }).count).toBe(26)
    for (const table of [
      'agent_home_retention_policies',
      'agent_home_retention_runs',
      'agent_home_raw_artifact_archives',
      'agent_home_evidence_bundle_repairs',
    ]) {
      expect((db.prepare(`SELECT COUNT(*) AS count FROM sqlite_master
        WHERE type='table' AND name=?`).get(table) as { count: number }).count).toBe(1)
    }
    db.close()
  })

  it('keeps provider acceptance evidence append-only and rerunnable', () => {
    const db = openDb(':memory:')
    const gates = Object.fromEntries([
      'executable_provenance',
      'subscription_billing',
      'credential_conflict',
      'managed_lifecycle',
      'restart_recovery',
      'raw_terminal_coexistence',
      'failure_semantics',
      'credential_redaction',
    ].map((gate) => [
      gate,
      {
        state: 'passed',
        evidence_refs: [`evidence/${gate}.json`],
      },
    ]))
    const matrix = {
      contract_version: 1,
      provider_id: 'codex',
      adapter_id: 'codex-app-server',
      adapter_version: '1.0.0',
      mode_id: 'native_subscription',
      runtime_mode: 'native_cli',
      billing_mode: 'personal_subscription',
      credential_kind: 'provider_account_session',
      executable_version: '0.144.6',
      platform: 'darwin-arm64',
      source_commit: 'a'.repeat(40),
      observed_at: '2026-07-28T12:00:00.000Z',
      gates,
    }
    const matrixJson = stableJson(matrix)
    const insert = db.prepare(`INSERT INTO provider_acceptance_evidence (
      id, contract_version, provider_id, adapter_id, adapter_version, mode_id,
      runtime_mode, billing_mode, credential_kind, executable_version, platform,
      source_commit, observed_at, matrix_json, matrix_sha256, artifact_ref,
      artifact_sha256, recorded_at
    ) VALUES (
      @id, @contract_version, @provider_id, @adapter_id, @adapter_version, @mode_id,
      @runtime_mode, @billing_mode, @credential_kind, @executable_version, @platform,
      @source_commit, @observed_at, @matrix_json, @matrix_sha256, @artifact_ref,
      @artifact_sha256, @recorded_at
    )`)
    const row = {
      id: `pe_${'a'.repeat(64)}`,
      ...matrix,
      matrix_json: matrixJson,
      matrix_sha256: canonicalHash(matrix),
      artifact_ref: 'evidence/codex-darwin-arm64.json',
      artifact_sha256: 'b'.repeat(64),
      recorded_at: '2026-07-28T12:01:00.000Z',
    }

    expect(() => insert.run(row)).not.toThrow()
    expect(() => db.prepare(`UPDATE provider_acceptance_evidence
      SET artifact_ref='evidence/replaced.json' WHERE id=?`).run(row.id))
      .toThrow(/immutable/)
    expect(() => db.prepare('DELETE FROM provider_acceptance_evidence WHERE id=?')
      .run(row.id)).toThrow(/immutable/)
    expect(() => insert.run({
      ...row,
      id: `pe_${'c'.repeat(64)}`,
      provider_id: 'claude',
      observed_at: '2026-07-28T12:02:00.000Z',
    })).toThrow(/matrix evidence is inconsistent/)

    db.prepare(`DELETE FROM os_schema_migrations
      WHERE id='019-provider-acceptance-evidence'`).run()
    expect(() => applyAgentOsMigrations(db)).not.toThrow()
    expect(db.prepare(`SELECT COUNT(*) AS count
      FROM provider_acceptance_evidence`).get()).toEqual({ count: 1 })
    expect(db.prepare(`SELECT COUNT(*) AS count FROM os_schema_migrations
      WHERE id='019-provider-acceptance-evidence'`).get()).toEqual({ count: 1 })
    db.close()
  })

  it('rejects a pre-existing incompatible provider acceptance schema', () => {
    const db = openDb(':memory:')
    db.exec(`
      DROP TABLE provider_acceptance_evidence;
      CREATE TABLE provider_acceptance_evidence (id TEXT PRIMARY KEY);
      DELETE FROM os_schema_migrations
      WHERE id='019-provider-acceptance-evidence';
    `)

    expect(() => applyAgentOsMigrations(db))
      .toThrow(/019-provider-acceptance-evidence found an incompatible evidence schema/)
    expect(db.prepare(`SELECT COUNT(*) AS count FROM os_schema_migrations
      WHERE id='019-provider-acceptance-evidence'`).get()).toEqual({ count: 0 })
    db.close()
  })

  it('repairs structured metadata, integrity aliases, conflicts, and transcript artifacts idempotently', () => {
    const db = openDb(':memory:')
    const boardId = Number(db.prepare(
      "INSERT INTO boards (project_path, name) VALUES ('/metadata-repair', 'metadata repair')",
    ).run().lastInsertRowid)
    db.prepare(`INSERT INTO workspaces
      (id, board_id, name, kind, root_path, status)
      VALUES ('metadata-repair-workspace', ?, 'metadata repair', 'shared',
        '/metadata-repair', 'active')`).run(boardId)
    db.prepare(`INSERT INTO agent_sessions
      (id, workspace_id, provider, status, context_json)
      VALUES ('metadata-repair-session', 'metadata-repair-workspace', 'codex', 'running', '{}')`)
      .run()

    const profiles = new AgentProfileService(db)
    const conversations = new ConversationService(db)
    const profile = profiles.create({
      boardId,
      name: 'Metadata repair',
      actor: { type: 'operator', id: 'migration-test' },
      idempotencyKey: 'metadata-repair:profile',
    })
    const conversation = conversations.listConversations(profile.id)[0]
    conversations.linkSession('metadata-repair-session', {
      profileId: profile.id,
      conversationId: conversation.id,
      mode: 'managed',
      providerThreadId: 'thread-resolved-from-session',
      actor: { type: 'operator', id: 'migration-test' },
      idempotencyKey: 'metadata-repair:link',
    })

    const privateKey = [
      '-----BEGIN PRIVATE KEY-----',
      'migration-private-material-must-not-survive',
      '-----END PRIVATE KEY-----',
    ].join('\n')
    const legacyMetadata = {
      nested: {
        authLine: 'Authorization: Basic Og==',
        cookieLine: 'Cookie: sid=migration-cookie-must-not-survive',
        keyMaterial: privateKey,
        apiKey: 'migration-api-key-must-not-survive',
        shortBasic: 'Authorization: Basic YTo',
        providerTokens: ['migration-short-provider-token-xy15'],
        apiKeys: ['migration-short-api-key-xy16'],
      },
      safe: {
        status: 'completed',
        token_usage: {
          total_tokens: 12,
          output_tokens: 4,
        },
      },
    }
    const first = conversations.appendEvent('metadata-repair-session', {
      idempotencyKey: 'metadata-repair:event:first',
      dedupeKey: 'metadata-repair:event',
      kind: 'assistant',
      projectedText: 'Authorization: Basic Og==',
      metadata: legacyMetadata,
      actor: { type: 'agent', id: 'codex' },
    })
    conversations.appendEvent('metadata-repair-session', {
      idempotencyKey: 'metadata-repair:event:alias',
      dedupeKey: 'metadata-repair:event',
      kind: 'assistant',
      projectedText: 'Authorization: Basic Og==',
      metadata: legacyMetadata,
      actor: { type: 'agent', id: 'codex' },
    })
    const collision = conversations.appendEvent('metadata-repair-session', {
      idempotencyKey: 'metadata-repair:event:collision',
      dedupeKey: 'metadata-repair:event:collision',
      providerThreadId: 'thread-collision-second',
      kind: 'assistant',
      projectedText: 'Authorization: Basic Og==',
      metadata: {
        ...legacyMetadata,
        safe: { ...legacyMetadata.safe, status: 'collision' },
      },
      actor: { type: 'agent', id: 'codex' },
    })
    expect(() => conversations.appendEvent('metadata-repair-session', {
      idempotencyKey: 'metadata-repair:event:conflict',
      dedupeKey: 'metadata-repair:event',
      kind: 'assistant',
      projectedText: 'Authorization: Basic Og==',
      metadata: {
        ...legacyMetadata,
        safe: { ...legacyMetadata.safe, status: 'changed' },
      },
      actor: { type: 'agent', id: 'codex' },
    })).toThrow(/conflict/)

    const conflictBefore = db.prepare(`SELECT id, received_content_hash
      FROM conversation_event_conflicts`).get() as {
      id: string
      received_content_hash: string
    }
    const legacyHash = '1'.repeat(64)
    db.prepare(`UPDATE conversation_events SET
      projected_text=?, metadata_json=?, redaction_state='none',
      content_hash=?, archived_at='2026-01-01T00:00:00.000Z'
      WHERE id IN (?, ?)`).run(
      'Authorization: Basic YTo',
      JSON.stringify(legacyMetadata),
      legacyHash,
      first.event.id,
      collision.event.id,
    )
    db.prepare(`UPDATE os_events SET payload=json_set(
      payload, '$.content_hash', ?, '$.request_fingerprint', ?
    ) WHERE kind IN ('conversation.event_appended', 'conversation.event_replayed')
      AND json_extract(payload, '$.conversation_event_id') IN (?, ?)`)
      .run(legacyHash, legacyHash, first.event.id, collision.event.id)
    db.prepare(`UPDATE conversation_event_conflicts
      SET received_projected_text=?, received_metadata_json=?
      WHERE id=?`).run(
      'Cookie: sid=migration-conflict-cookie-must-not-survive',
      JSON.stringify({
        nested: {
          'set-cookie': 'migration-conflict-cookie-must-not-survive',
          keyMaterial: privateKey,
          tokens: ['migration-conflict-short-token-xy17'],
        },
      }),
      conflictBefore.id,
    )
    db.prepare(`UPDATE os_events SET payload=json_set(
      payload, '$.canonical_content_hash', ?
    ) WHERE kind='conversation.event_conflict'
      AND json_extract(payload, '$.canonical_event_id')=?`)
      .run(legacyHash, first.event.id)

    const artifacts = new ArtifactStore(db)
    const events = new EventStore(db)
    const digest = (value: string) => createHash('sha256').update(value).digest('hex')
    const legacyJsonContent = `${JSON.stringify({
      schema_version: 1,
      redaction_policy: { redactions_applied: 0 },
      events: [{
        id: first.event.id,
        content_hash: legacyHash,
        metadata: {
          authLine: 'Basic YTo',
          keyMaterial: privateKey,
        },
      }, {
        id: collision.event.id,
        content_hash: legacyHash,
        metadata: {
          status: 'collision',
        },
      }],
      provenance: {
        event_ids: [first.event.id, collision.event.id],
        source_content_hashes: [legacyHash, legacyHash],
      },
    }, null, 2)}\n`
    const jsonArtifact = artifacts.create({
      boardId,
      kind: 'agent_home_transcript',
      name: 'legacy.json',
      mimeType: 'application/json',
      content: legacyJsonContent,
      metadata: {
        content_hash: digest(legacyJsonContent),
        format: 'json',
        redactions_applied: 0,
        pinned: true,
        authorization: 'Basic Og',
        nested: {
          apiKey: 'artifact-row-api-key-must-not-survive',
        },
      },
    })
    const legacyHumanContent = [
      '# Legacy transcript',
      `event=${first.event.id} session=metadata-repair-session hash=${legacyHash}`,
      'Authorization: Basic Og==',
      privateKey,
      '',
    ].join('\n')
    const humanArtifact = artifacts.create({
      boardId,
      kind: 'agent_home_transcript',
      name: 'legacy.md',
      mimeType: 'text/markdown',
      content: legacyHumanContent,
      metadata: {
        content_hash: digest(legacyHumanContent),
        format: 'human',
        redactions_applied: 0,
      },
    })
    const malformedContent = '{"authorization":"Basic Og==",'
    const malformedArtifact = artifacts.create({
      boardId,
      kind: 'agent_home_transcript',
      name: 'malformed.json',
      mimeType: 'application/json',
      content: malformedContent,
      metadata: {
        content_hash: digest(malformedContent),
        format: 'json',
        redactions_applied: 0,
      },
    })
    const stableContent = `${JSON.stringify({ safe: true }, null, 2)}\n`
    const stableArtifact = artifacts.create({
      boardId,
      kind: 'agent_home_transcript',
      name: 'stable.json',
      mimeType: 'application/json',
      content: stableContent,
      metadata: {
        content_hash: digest(stableContent),
        format: 'json',
        redactions_applied: 0,
      },
    })
    const unrelatedContent = 'Cookie: unrelated-artifact-must-remain-byte-identical'
    const unrelatedArtifact = artifacts.create({
      boardId,
      kind: 'evidence_bundle',
      name: 'unrelated.txt',
      mimeType: 'text/plain',
      content: unrelatedContent,
      metadata: { safe: true },
    })
    for (const artifact of [jsonArtifact, humanArtifact, malformedArtifact, stableArtifact]) {
      events.append({
        boardId,
        kind: 'agent_home.transcript_exported',
        source: 'migration-test',
        idempotencyKey: `metadata-repair:artifact:${artifact.id}`,
        payload: {
          artifact_id: artifact.id,
          content_hash: artifact.id === stableArtifact.id
            ? 'stale-safe-audit-hash'
            : String(artifact.metadata.content_hash),
          request_fingerprint: `command:${artifact.id}`,
        },
      })
    }

    db.prepare(`DELETE FROM os_schema_migrations
      WHERE id='013-agent-home-structured-metadata-redaction'`).run()
    applyAgentOsMigrations(db)

    const repairedEvent = db.prepare(`SELECT projected_text, metadata_json, content_hash,
        redaction_state, archived_at
      FROM conversation_events WHERE id=?`).get(first.event.id) as {
      projected_text: string
      metadata_json: string
      content_hash: string
      redaction_state: string
      archived_at: string
    }
    expect(repairedEvent).toMatchObject({
      projected_text: 'Authorization: Basic [REDACTED]',
      redaction_state: 'redacted',
      archived_at: '2026-01-01T00:00:00.000Z',
    })
    expect(repairedEvent.content_hash).toMatch(/^[a-f0-9]{64}$/)
    expect(repairedEvent.content_hash).not.toBe(legacyHash)
    expect(JSON.parse(repairedEvent.metadata_json)).toMatchObject({
      nested: {
        authLine: 'Authorization: Basic [REDACTED]',
        cookieLine: '[REDACTED]',
        keyMaterial: '[REDACTED]',
        apiKey: '[REDACTED]',
        shortBasic: 'Authorization: Basic [REDACTED]',
        providerTokens: '[REDACTED]',
        apiKeys: '[REDACTED]',
      },
      safe: {
        status: 'completed',
        token_usage: {
          total_tokens: 12,
          output_tokens: 4,
        },
      },
    })
    const repairedCollision = db.prepare(`SELECT provider_thread_id, content_hash
      FROM conversation_events WHERE id=?`).get(collision.event.id) as {
      provider_thread_id: string
      content_hash: string
    }
    expect(repairedCollision.provider_thread_id).toBe('thread-collision-second')
    expect(repairedCollision.content_hash).toMatch(/^[a-f0-9]{64}$/)
    expect(repairedCollision.content_hash).not.toBe(legacyHash)
    expect(repairedCollision.content_hash).not.toBe(repairedEvent.content_hash)

    const aliases = db.prepare(`SELECT payload FROM os_events
      WHERE kind IN ('conversation.event_appended', 'conversation.event_replayed')
        AND json_extract(payload, '$.conversation_event_id')=?
      ORDER BY id`).all(first.event.id) as Array<{ payload: string }>
    expect(aliases).toHaveLength(2)
    for (const alias of aliases) {
      expect(JSON.parse(alias.payload)).toMatchObject({
        content_hash: repairedEvent.content_hash,
        request_fingerprint: repairedEvent.content_hash,
      })
    }
    const collisionAliases = db.prepare(`SELECT payload FROM os_events
      WHERE kind IN ('conversation.event_appended', 'conversation.event_replayed')
        AND json_extract(payload, '$.conversation_event_id')=?`).all(
      collision.event.id,
    ) as Array<{ payload: string }>
    expect(collisionAliases).toHaveLength(1)
    expect(JSON.parse(collisionAliases[0].payload)).toMatchObject({
      content_hash: repairedCollision.content_hash,
      request_fingerprint: repairedCollision.content_hash,
    })
    const conflictAfter = db.prepare(`SELECT received_content_hash, received_projected_text,
        received_metadata_json
      FROM conversation_event_conflicts WHERE id=?`).get(conflictBefore.id) as {
      received_content_hash: string
      received_projected_text: string
      received_metadata_json: string
    }
    expect(conflictAfter.received_content_hash).toBe(conflictBefore.received_content_hash)
    expect(conflictAfter.received_projected_text).toBe('Cookie: [REDACTED]')
    expect(conflictAfter.received_metadata_json)
      .not.toContain('migration-conflict-cookie-must-not-survive')
    expect((db.prepare(`SELECT json_extract(payload, '$.canonical_content_hash') AS hash
      FROM os_events WHERE kind='conversation.event_conflict'
        AND json_extract(payload, '$.canonical_event_id')=?`).get(first.event.id) as {
      hash: string
    }).hash).toBe(repairedEvent.content_hash)

    expect(conversations.appendEvent('metadata-repair-session', {
      idempotencyKey: 'metadata-repair:event:first',
      dedupeKey: 'metadata-repair:event',
      kind: 'assistant',
      projectedText: 'Authorization: Basic Og==',
      metadata: legacyMetadata,
      actor: { type: 'agent', id: 'codex' },
    })).toMatchObject({
      replayed: true,
      event: { id: first.event.id, content_hash: repairedEvent.content_hash },
    })
    expect(conversations.appendEvent('metadata-repair-session', {
      idempotencyKey: 'metadata-repair:event:alias',
      dedupeKey: 'metadata-repair:event',
      providerThreadId: 'thread-resolved-from-session',
      kind: 'assistant',
      projectedText: 'Authorization: Basic Og==',
      metadata: legacyMetadata,
      actor: { type: 'agent', id: 'codex' },
    })).toMatchObject({
      replayed: true,
      event: { id: first.event.id, content_hash: repairedEvent.content_hash },
    })
    expect(() => conversations.appendEvent('metadata-repair-session', {
      idempotencyKey: 'metadata-repair:event:changed-safe-value',
      dedupeKey: 'metadata-repair:event',
      kind: 'assistant',
      projectedText: 'Authorization: Basic Og==',
      metadata: {
        ...legacyMetadata,
        safe: { ...legacyMetadata.safe, status: 'different-safe-value' },
      },
      actor: { type: 'agent', id: 'codex' },
    })).toThrow(/conflict/)

    const repairedArtifacts = new Map((db.prepare(`SELECT id, content, metadata
      FROM artifacts WHERE kind='agent_home_transcript'`).all() as Array<{
      id: string
      content: string
      metadata: string
    }>).map((artifact) => [artifact.id, artifact]))
    const repairedJson = repairedArtifacts.get(jsonArtifact.id)!
    const repairedJsonDocument = JSON.parse(repairedJson.content)
    expect(repairedJsonDocument.events[0]).toMatchObject({
      id: first.event.id,
      content_hash: repairedEvent.content_hash,
      metadata: {
        authLine: 'Basic [REDACTED]',
        keyMaterial: '[REDACTED]',
      },
    })
    expect(repairedJsonDocument.events[1]).toMatchObject({
      id: collision.event.id,
      content_hash: repairedCollision.content_hash,
      metadata: { status: 'collision' },
    })
    expect(repairedJsonDocument.provenance.source_content_hashes)
      .toEqual([repairedEvent.content_hash, repairedCollision.content_hash])
    expect(repairedArtifacts.get(humanArtifact.id)!.content)
      .toContain(`hash=${repairedEvent.content_hash}`)
    expect(repairedArtifacts.get(humanArtifact.id)!.content)
      .toContain('Authorization: Basic [REDACTED]')
    expect(JSON.parse(repairedArtifacts.get(malformedArtifact.id)!.content)).toEqual({
      redacted: true,
      reason: 'malformed_legacy_transcript',
    })
    expect(repairedArtifacts.get(stableArtifact.id)!.content).toBe(stableContent)
    expect((db.prepare('SELECT content, metadata FROM artifacts WHERE id=?')
      .get(unrelatedArtifact.id) as { content: string; metadata: string })).toEqual({
      content: unrelatedContent,
      metadata: JSON.stringify({ safe: true }),
    })

    for (const artifact of [jsonArtifact, humanArtifact, malformedArtifact, stableArtifact]) {
      const repaired = repairedArtifacts.get(artifact.id)!
      const metadata = JSON.parse(repaired.metadata)
      expect(metadata.content_hash).toBe(digest(repaired.content))
      if (artifact.id === jsonArtifact.id) {
        expect(metadata).toMatchObject({
          authorization: '[REDACTED]',
          nested: { apiKey: '[REDACTED]' },
        })
      }
      const audit = db.prepare(`SELECT payload FROM os_events
        WHERE kind='agent_home.transcript_exported'
          AND json_extract(payload, '$.artifact_id')=?`).get(artifact.id) as {
        payload: string
      }
      expect(JSON.parse(audit.payload)).toMatchObject({
        content_hash: digest(repaired.content),
        request_fingerprint: `command:${artifact.id}`,
      })
    }
    expect((db.prepare(`SELECT COUNT(*) AS count FROM agent_home_transcript_repairs`)
      .get() as { count: number }).count).toBe(3)
    expect((db.prepare(`SELECT COUNT(*) AS count FROM agent_home_transcript_repairs
      WHERE original_content_sha256!=repaired_content_sha256
        AND original_metadata_sha256!=repaired_metadata_sha256`)
      .get() as { count: number }).count).toBeGreaterThanOrEqual(1)

    const sentinels = [
      'Og==',
      'migration-private-material-must-not-survive',
      'migration-cookie-must-not-survive',
      'migration-api-key-must-not-survive',
      'migration-conflict-cookie-must-not-survive',
      'artifact-row-api-key-must-not-survive',
      'migration-short-provider-token-xy15',
      'migration-short-api-key-xy16',
      'migration-conflict-short-token-xy17',
      'YTo',
    ]
    const protectedRows = [
      ...(db.prepare('SELECT metadata_json AS value FROM conversation_events').all() as Array<{
        value: string
      }>),
      ...(db.prepare(`SELECT received_metadata_json AS value
        FROM conversation_event_conflicts`).all() as Array<{ value: string }>),
      ...(db.prepare('SELECT payload AS value FROM os_events').all() as Array<{ value: string }>),
      ...(db.prepare(`SELECT coalesce(content, '') || metadata AS value FROM artifacts
        WHERE kind='agent_home_transcript'`).all() as Array<{ value: string }>),
    ].map((row) => row.value).join('\n')
    for (const sentinel of sentinels) expect(protectedRows).not.toContain(sentinel)

    const snapshot = JSON.stringify({
      events: db.prepare(`SELECT id, projected_text, metadata_json, content_hash,
        redaction_state FROM conversation_events ORDER BY id`).all(),
      conflicts: db.prepare(`SELECT id, received_content_hash, received_projected_text,
        received_metadata_json FROM conversation_event_conflicts ORDER BY id`).all(),
      artifacts: db.prepare(`SELECT id, content, metadata FROM artifacts
        WHERE kind='agent_home_transcript' ORDER BY id`).all(),
      audits: db.prepare(`SELECT id, payload FROM os_events ORDER BY id`).all(),
      repairs: db.prepare(`SELECT * FROM agent_home_transcript_repairs ORDER BY artifact_id`).all(),
    })
    db.prepare(`DELETE FROM os_schema_migrations
      WHERE id='013-agent-home-structured-metadata-redaction'`).run()
    applyAgentOsMigrations(db)
    const rerunSnapshot = JSON.stringify({
      events: db.prepare(`SELECT id, projected_text, metadata_json, content_hash,
        redaction_state FROM conversation_events ORDER BY id`).all(),
      conflicts: db.prepare(`SELECT id, received_content_hash, received_projected_text,
        received_metadata_json FROM conversation_event_conflicts ORDER BY id`).all(),
      artifacts: db.prepare(`SELECT id, content, metadata FROM artifacts
        WHERE kind='agent_home_transcript' ORDER BY id`).all(),
      audits: db.prepare(`SELECT id, payload FROM os_events ORDER BY id`).all(),
      repairs: db.prepare(`SELECT * FROM agent_home_transcript_repairs ORDER BY artifact_id`).all(),
    })
    expect(rerunSnapshot).toBe(snapshot)
    expect((db.prepare(`SELECT COUNT(*) AS count FROM os_schema_migrations
      WHERE id='013-agent-home-structured-metadata-redaction'`).get() as {
      count: number
    }).count).toBe(1)
    db.close()
  })

  it('orders migration 014 after prior migrations and backfills legacy action state', () => {
    const db = openDb(':memory:')
    const boardId = Number(db.prepare(
      "INSERT INTO boards (project_path, name) VALUES ('/fork-migration', 'fork migration')",
    ).run().lastInsertRowid)
    db.prepare(`INSERT INTO workspaces
      (id, board_id, name, kind, root_path, status)
      VALUES ('fork-migration-workspace', ?, 'fork migration', 'shared',
        '/fork-migration', 'active')`).run(boardId)
    for (const id of ['legacy-parent', 'legacy-child', 'legacy-pending', 'legacy-failed']) {
      db.prepare(`INSERT INTO agent_sessions
        (id, workspace_id, provider, status, context_json)
        VALUES (?, 'fork-migration-workspace', 'codex', 'idle', '{}')`).run(id)
    }
    const profile = new AgentProfileService(db).create({
      boardId,
      name: 'Fork migration profile',
      actor: { type: 'operator', id: 'migration-test' },
      idempotencyKey: 'fork-migration:profile',
    })
    const conversation = new ConversationService(db).listConversations(profile.id)[0]!
    db.prepare(`UPDATE agent_sessions SET profile_id=?, conversation_id=?
      WHERE workspace_id='fork-migration-workspace'`).run(profile.id, conversation.id)
    const at = '2026-07-25T00:00:00.000Z'
    db.exec(`
      DROP TRIGGER agent_conversations_session_action_scope_update;
      DROP TRIGGER agent_profiles_session_action_scope_update;
      DROP TRIGGER workspaces_session_action_scope_update;
      DROP TRIGGER agent_sessions_action_scope_update;
      DROP TRIGGER os_events_action_request_identity_update;
      DROP TRIGGER agent_session_actions_command_identity_update;
      DROP TRIGGER agent_session_actions_home_scope_update;
      DROP TRIGGER agent_session_actions_home_scope_insert;
      DROP INDEX idx_os_events_idempotency_key_global;
      DROP INDEX idx_os_events_action_request_fingerprint_identity;
      DROP INDEX idx_os_events_action_request_command_identity;
      DROP INDEX idx_agent_session_actions_request_identity;
      DROP INDEX idx_agent_session_actions_command_identity;
      DROP TRIGGER agent_session_action_reconciliation_scope_update;
      DROP TRIGGER agent_session_action_reconciliation_scope_insert;
      DROP TABLE agent_session_action_reconciliations;
      DROP INDEX idx_agent_session_actions_fork_outcome;
      ALTER TABLE agent_session_actions DROP COLUMN effect_json;
      ALTER TABLE agent_session_actions DROP COLUMN effect_state;
      ALTER TABLE agent_session_actions DROP COLUMN reserved_session_id;
      DELETE FROM os_schema_migrations
        WHERE id IN (
          '014-agent-home-native-fork-lifecycle',
          '015-agent-home-action-command-scope'
        );
    `)
    const insert = db.prepare(`INSERT INTO agent_session_actions (
      id, board_id, session_id, result_session_id, idempotency_key, action,
      request_fingerprint, status, lease_id, actor_type, actor_id,
      error_code, error_message, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'legacy-lease', 'operator', 'migration',
      NULL, NULL, ?, ?)`)
    insert.run(
      'legacy-fork-action',
      boardId,
      'legacy-parent',
      'legacy-child',
      'legacy-fork',
      'fork',
      canonicalHash({ command: 'agent_session.fork', sessionId: 'legacy-parent' }),
      'succeeded',
      at,
      at,
    )
    insert.run(
      'legacy-pending-action',
      boardId,
      'legacy-pending',
      null,
      'legacy-pending',
      'pause',
      canonicalHash({ command: 'agent_session.pause', sessionId: 'legacy-pending' }),
      'pending',
      at,
      at,
    )
    insert.run(
      'legacy-failed-action',
      boardId,
      'legacy-failed',
      null,
      'legacy-failed',
      'stop',
      canonicalHash({ command: 'agent_session.stop', sessionId: 'legacy-failed' }),
      'failed',
      at,
      at,
    )

    applyAgentOsMigrations(db)

    expect(db.prepare(`SELECT id, reserved_session_id, effect_state, effect_json
      FROM agent_session_actions ORDER BY id`).all()).toEqual([
      {
        id: 'legacy-failed-action',
        reserved_session_id: null,
        effect_state: 'completed',
        effect_json: '{}',
      },
      {
        id: 'legacy-fork-action',
        reserved_session_id: 'legacy-child',
        effect_state: 'completed',
        effect_json: '{}',
      },
      {
        id: 'legacy-pending-action',
        reserved_session_id: null,
        effect_state: 'reserved',
        effect_json: '{}',
      },
    ])
    expect((db.prepare(`SELECT COUNT(*) AS count FROM sqlite_master
      WHERE type='table' AND name='agent_session_action_reconciliations'`)
      .get() as { count: number }).count).toBe(1)
    const ids = (db.prepare('SELECT id FROM os_schema_migrations ORDER BY rowid')
      .all() as Array<{ id: string }>).map((row) => row.id)
    expect(ids.slice(-10)).toEqual([
      '019-provider-acceptance-evidence',
      '020-causal-event-metadata',
      '021-command-idempotency-coverage',
      '022-legacy-projection-forward-plan',
      '023-compatibility-migration-telemetry',
      '024-compatibility-migration-failure-journal',
      '025-knowledge-retrieval',
      '026-job-agent-brief',
      '014-agent-home-native-fork-lifecycle',
      '015-agent-home-action-command-scope',
    ])
    expect(ids.at(-1)).toBe('015-agent-home-action-command-scope')
    db.close()
  })

  it('applies migration 015 forward and fails closed on displaced or ambiguous action state', () => {
    const db = openDb(':memory:')
    const firstBoardId = Number(db.prepare(`INSERT INTO boards (project_path, name)
      VALUES ('/action-scope-first', 'Action scope first')`).run().lastInsertRowid)
    const secondBoardId = Number(db.prepare(`INSERT INTO boards (project_path, name)
      VALUES ('/action-scope-second', 'Action scope second')`).run().lastInsertRowid)
    db.prepare(`INSERT INTO workspaces
      (id, board_id, name, kind, root_path, status)
      VALUES ('action-scope-first-workspace', ?, 'First', 'shared',
        '/action-scope-first', 'active')`).run(firstBoardId)
    db.prepare(`INSERT INTO workspaces
      (id, board_id, name, kind, root_path, status)
      VALUES ('action-scope-second-workspace', ?, 'Second', 'shared',
        '/action-scope-second', 'active')`).run(secondBoardId)
    db.prepare(`INSERT INTO agent_sessions
      (id, workspace_id, provider, status, context_json)
      VALUES ('action-scope-session', 'action-scope-first-workspace',
        'codex', 'idle', '{}')`).run()
    const firstProfile = new AgentProfileService(db).create({
      boardId: firstBoardId,
      name: 'Action scope first',
      actor: { type: 'operator', id: 'migration-test' },
      idempotencyKey: 'action-scope:first-profile',
    })
    const secondProfile = new AgentProfileService(db).create({
      boardId: secondBoardId,
      name: 'Action scope second',
      actor: { type: 'operator', id: 'migration-test' },
      idempotencyKey: 'action-scope:second-profile',
    })
    const firstConversation = new ConversationService(db)
      .listConversations(firstProfile.id)[0]!
    const secondConversation = new ConversationService(db)
      .listConversations(secondProfile.id)[0]!
    db.prepare(`UPDATE agent_sessions SET profile_id=?, conversation_id=?
      WHERE id='action-scope-session'`).run(firstProfile.id, firstConversation.id)
    const actionScopeFingerprint = canonicalHash({
      command: 'agent_session.pause',
      sessionId: 'action-scope-session',
    })

    db.exec(`
      DROP TRIGGER agent_conversations_session_action_scope_update;
      DROP TRIGGER agent_profiles_session_action_scope_update;
      DROP TRIGGER workspaces_session_action_scope_update;
      DROP TRIGGER agent_sessions_action_scope_update;
      DROP TRIGGER os_events_action_request_identity_update;
      DROP TRIGGER agent_session_actions_command_identity_update;
      DROP TRIGGER agent_session_actions_home_scope_update;
      DROP TRIGGER agent_session_actions_home_scope_insert;
      DROP INDEX idx_os_events_idempotency_key_global;
      DROP INDEX idx_os_events_action_request_fingerprint_identity;
      DROP INDEX idx_os_events_action_request_command_identity;
      DROP INDEX idx_agent_session_actions_request_identity;
      DROP INDEX idx_agent_session_actions_command_identity;
      DELETE FROM os_schema_migrations
        WHERE id='015-agent-home-action-command-scope';
    `)
    db.prepare(`INSERT INTO agent_session_actions (
      id, board_id, session_id, result_session_id, idempotency_key, action,
      request_fingerprint, status, lease_id, reserved_session_id, effect_state,
      effect_json, actor_type, actor_id, error_code, error_message, created_at, updated_at
    ) VALUES (
      'action-scope-legacy', ?, 'action-scope-session', NULL,
      'action-scope:legacy', 'pause', ?, 'failed',
      'legacy-lease', NULL, 'completed', '{}', 'operator', 'migration-test',
      'action_interrupted', 'legacy interrupted action', datetime('now'), datetime('now')
    )`).run(
      secondBoardId,
      actionScopeFingerprint,
    )

    expect(() => applyAgentOsMigrations(db))
      .toThrow(/agent session action board scope is inconsistent/)
    expect(db.prepare(`SELECT COUNT(*) AS count FROM os_schema_migrations
      WHERE id='015-agent-home-action-command-scope'`).get()).toEqual({ count: 0 })
    expect(db.prepare(`SELECT COUNT(*) AS count FROM sqlite_master
      WHERE type='trigger' AND name='agent_session_actions_home_scope_update'`).get())
      .toEqual({ count: 0 })
    expect(db.prepare(`SELECT COUNT(*) AS count FROM sqlite_master
      WHERE type='index' AND name='idx_os_events_idempotency_key_global'`).get())
      .toEqual({ count: 0 })

    db.prepare(`UPDATE agent_session_actions SET board_id=?
      WHERE id='action-scope-legacy'`).run(firstBoardId)
    const displacedRequest = new EventStore(db).append({
      boardId: secondBoardId,
      sessionId: 'action-scope-session',
      idempotencyKey: 'action-scope:legacy',
      kind: 'agent_session.action_requested',
      source: 'agent-home',
      payload: {
        action_id: 'action-scope-legacy',
        action: 'pause',
        session_id: 'action-scope-session',
        profile_id: firstProfile.id,
        conversation_id: firstConversation.id,
        request_fingerprint: actionScopeFingerprint,
        actor: { type: 'operator', id: 'migration-test' },
      },
    })
    expect(() => applyAgentOsMigrations(db))
      .toThrow(/request audit scope is inconsistent/)
    expect(db.prepare(`SELECT COUNT(*) AS count FROM os_schema_migrations
      WHERE id='015-agent-home-action-command-scope'`).get()).toEqual({ count: 0 })
    db.prepare('DELETE FROM os_events WHERE id=?').run(displacedRequest.id)

    db.prepare(`INSERT INTO agent_session_actions (
      id, board_id, session_id, result_session_id, idempotency_key, action,
      request_fingerprint, status, lease_id, reserved_session_id, effect_state,
      effect_json, actor_type, actor_id, error_code, error_message, created_at, updated_at
    )
    SELECT 'action-scope-ambiguous', ?, session_id, result_session_id,
      idempotency_key, action, request_fingerprint, status, lease_id,
      reserved_session_id, effect_state, effect_json, actor_type, actor_id,
      error_code, error_message, created_at, updated_at
    FROM agent_session_actions WHERE id='action-scope-legacy'`).run(secondBoardId)

    expect(() => applyAgentOsMigrations(db))
      .toThrow(/command identity is ambiguous/)
    expect(db.prepare(`SELECT COUNT(*) AS count FROM os_schema_migrations
      WHERE id='015-agent-home-action-command-scope'`).get()).toEqual({ count: 0 })

    db.prepare("DELETE FROM agent_session_actions WHERE id='action-scope-ambiguous'").run()
    expect(() => applyAgentOsMigrations(db)).not.toThrow()
    expect(db.prepare(`SELECT COUNT(*) AS count FROM os_schema_migrations
      WHERE id='015-agent-home-action-command-scope'`).get()).toEqual({ count: 1 })
    expect((db.prepare('SELECT COUNT(*) AS count FROM os_schema_migrations')
      .get() as { count: number }).count).toBe(26)
    const requestLookupPlan = db.prepare(`EXPLAIN QUERY PLAN
      SELECT id, board_id, kind, source, workspace_id, card_id, session_id,
        process_id, job_id, contract_id, correlation_id, causation_id,
        event_version, payload
      FROM os_events
      WHERE idempotency_key=?
        AND json_valid(payload)
        AND (
          json_extract(payload, '$.request_fingerprint')=?
          OR (
            json_extract(payload, '$.session_id')=?
            AND json_extract(payload, '$.action')=?
          )
        )
      ORDER BY rowid`).all(
      'action-scope:legacy',
      actionScopeFingerprint,
      'action-scope-session',
      'pause',
    ) as Array<{ detail: string }>
    expect(requestLookupPlan.map((step) => step.detail).join('\n'))
      .toContain('idx_os_events_idempotency_key_global')

    expect(() => db.prepare(`UPDATE agent_session_actions SET board_id=?
      WHERE id='action-scope-legacy'`).run(secondBoardId))
      .toThrow(/agent session action board scope is inconsistent/)
    expect(() => db.prepare(`INSERT INTO agent_session_actions (
      id, board_id, session_id, result_session_id, idempotency_key, action,
      request_fingerprint, status, lease_id, reserved_session_id, effect_state,
      effect_json, actor_type, actor_id, error_code, error_message, created_at, updated_at
    ) VALUES (
      'action-scope-invalid-insert', ?, 'action-scope-session', NULL,
      'action-scope:invalid-insert', 'pause', 'invalid-insert-fingerprint', 'failed',
      'legacy-lease', NULL, 'completed', '{}', 'operator', 'migration-test',
      'action_interrupted', 'invalid insert', datetime('now'), datetime('now')
    )`).run(secondBoardId)).toThrow(/agent session action board scope is inconsistent/)
    expect(() => db.prepare(`UPDATE agent_sessions
      SET workspace_id='action-scope-second-workspace',
        profile_id=?, conversation_id=?
      WHERE id='action-scope-session'`).run(
      secondProfile.id,
      secondConversation.id,
    )).toThrow(/agent session action board scope is inconsistent/)
    expect(() => db.prepare(`UPDATE workspaces SET board_id=?
      WHERE id='action-scope-first-workspace'`).run(secondBoardId))
      .toThrow(/would displace an agent session action/)
    db.close()
  })

  it('repairs false-withheld native projections without restoring provider reasoning', () => {
    const db = openDb(':memory:')
    const boardId = Number(db.prepare(
      "INSERT INTO boards (project_path, name) VALUES ('/legacy-redaction', 'legacy redaction')",
    ).run().lastInsertRowid)
    db.prepare(`INSERT INTO workspaces
      (id, board_id, name, kind, root_path, status)
      VALUES ('legacy-redaction-workspace', ?, 'legacy', 'shared', '/legacy-redaction', 'active')`)
      .run(boardId)
    db.prepare(`INSERT INTO agent_sessions
      (id, workspace_id, provider, status, context_json)
      VALUES ('legacy-claude-session', 'legacy-redaction-workspace', 'claude', 'running', '{}'),
             ('legacy-codex-session', 'legacy-redaction-workspace', 'codex', 'running', '{}')`).run()
    const profile = new AgentProfileService(db).create({
      boardId,
      name: 'Legacy redaction',
      actor: { type: 'operator', id: 'migration-test' },
      idempotencyKey: 'legacy-redaction:profile',
    })
    const conversations = new ConversationService(db)
    const conversation = conversations.listConversations(profile.id)[0]
    for (const [sessionId, driverId] of [
      ['legacy-claude-session', 'claude'],
      ['legacy-codex-session', 'codex'],
    ] as const) {
      conversations.linkSession(sessionId, {
        profileId: profile.id,
        conversationId: conversation.id,
        mode: 'managed',
        driverId,
        recoveryState: 'attachable',
        historyState: 'complete',
        actor: { type: 'operator', id: 'migration-test' },
        idempotencyKey: `legacy-redaction:link:${driverId}`,
      })
    }
    const appendLegacy = (
      sessionId: string,
      provider: 'claude' | 'codex',
      dedupeKey: string,
    ) => conversations.appendEvent(sessionId, {
      idempotencyKey: `legacy-redaction:event:${dedupeKey}`,
      dedupeKey,
      kind: 'assistant',
      provider,
      projectedText: 'placeholder',
      actor: { type: 'provider', id: provider },
    }).event.id
    const ids = {
      claudeText: appendLegacy('legacy-claude-session', 'claude', 'legacy:claude:text'),
      claudePreRedacted: appendLegacy('legacy-claude-session', 'claude', 'legacy:claude:pre-redacted'),
      claudeThinking: appendLegacy('legacy-claude-session', 'claude', 'legacy:claude:thinking'),
      codexText: appendLegacy('legacy-codex-session', 'codex', 'legacy:codex:text'),
      codexReasoning: appendLegacy('legacy-codex-session', 'codex', 'legacy:codex:reasoning'),
      explicitWithheld: appendLegacy('legacy-codex-session', 'codex', 'legacy:explicit:withheld'),
    }
    const mutate = db.prepare(`UPDATE conversation_events
      SET projected_text=?, metadata_json=?, redaction_state='withheld', content_hash=?
      WHERE id=?`)
    mutate.run(
      'Claude visible answer',
      JSON.stringify({
        provider_native: true,
        provider_native_schema: 'claude-agent-sdk-message',
        native_block_type: 'text',
        raw_payload_state: 'withheld',
      }),
      'legacy-claude-text-hash',
      ids.claudeText,
    )
    mutate.run(
      'claude private reasoning',
      JSON.stringify({
        provider_native: true,
        provider_native_schema: 'claude-agent-sdk-message',
        native_block_type: 'thinking',
        raw_payload_state: 'withheld',
      }),
      'legacy-claude-thinking-hash',
      ids.claudeThinking,
    )
    db.prepare(`UPDATE conversation_events
      SET projected_text='Already [REDACTED]', metadata_json=?,
          redaction_state='redacted', content_hash=?
      WHERE id=?`).run(
      JSON.stringify({
        provider_native: true,
        provider_native_schema: 'claude-agent-sdk-message',
        native_block_type: 'text',
        raw_payload_state: 'redacted',
      }),
      'a'.repeat(64),
      ids.claudePreRedacted,
    )
    mutate.run(
      'Codex visible sk-abcdefghijklmnopqrstuvwxyz123456',
      JSON.stringify({
        native_method: 'item/agentMessage/delta',
        raw_payload_state: 'withheld',
      }),
      'legacy-codex-text-hash',
      ids.codexText,
    )
    mutate.run(
      'codex private reasoning',
      JSON.stringify({
        native_method: 'item/reasoning/textDelta',
        raw_payload_state: 'withheld',
      }),
      'legacy-codex-reasoning-hash',
      ids.codexReasoning,
    )
    mutate.run(
      'explicitly withheld secret',
      '{}',
      'legacy-explicit-withheld-hash',
      ids.explicitWithheld,
    )
    db.prepare(`DELETE FROM os_schema_migrations
      WHERE id='010-agent-home-projected-text-redaction'`).run()

    applyAgentOsMigrations(db)
    applyAgentOsMigrations(db)

    const repaired = db.prepare(`SELECT id, projected_text, redaction_state, content_hash
      FROM conversation_events WHERE id IN (?, ?, ?, ?, ?, ?) ORDER BY id`).all(
      ids.claudeText,
      ids.claudePreRedacted,
      ids.claudeThinking,
      ids.codexText,
      ids.codexReasoning,
      ids.explicitWithheld,
    ) as Array<{
      id: string
      projected_text: string | null
      redaction_state: string
      content_hash: string
    }>
    const byId = new Map(repaired.map((event) => [event.id, event]))
    expect(byId.get(ids.claudeText)).toMatchObject({
      projected_text: 'Claude visible answer',
      redaction_state: 'none',
    })
    expect(byId.get(ids.codexText)).toMatchObject({
      projected_text: 'Codex visible [REDACTED]',
      redaction_state: 'redacted',
    })
    expect(byId.get(ids.claudePreRedacted)).toMatchObject({
      projected_text: 'Already [REDACTED]',
      redaction_state: 'redacted',
    })
    for (const id of [ids.claudeThinking, ids.codexReasoning, ids.explicitWithheld]) {
      expect(byId.get(id)).toMatchObject({
        projected_text: null,
        redaction_state: 'withheld',
      })
    }
    expect(repaired.every((event) => /^[a-f0-9]{64}$/.test(event.content_hash))).toBe(true)
    expect(conversations.appendEvent('legacy-codex-session', {
      idempotencyKey: 'legacy-redaction:event:legacy:codex:text',
      dedupeKey: 'legacy:codex:text',
      kind: 'assistant',
      provider: 'codex',
      projectedText: 'Codex visible sk-abcdefghijklmnopqrstuvwxyz123456',
      metadata: {
        native_method: 'item/agentMessage/delta',
        raw_payload_state: 'withheld',
      },
      actor: { type: 'provider', id: 'codex' },
    })).toMatchObject({
      replayed: true,
      event: {
        id: ids.codexText,
        projected_text: 'Codex visible [REDACTED]',
        redaction_state: 'redacted',
      },
    })
    expect((db.prepare('SELECT COUNT(*) AS count FROM os_schema_migrations').get() as any).count)
      .toBe(26)
    db.close()
  })

  it('scrubs legacy managed driver secrets while preserving safe transcript meaning', () => {
    const db = openDb(':memory:')
    const boardId = Number(db.prepare(
      "INSERT INTO boards (project_path, name) VALUES ('/legacy-approval-payload', 'legacy approval payload')",
    ).run().lastInsertRowid)
    const events = new EventStore(db)
    const sentinels = {
      command: 'LEGACY_APPROVAL_COMMAND_SECRET_1a2b',
      path: '/private/LEGACY_APPROVAL_PATH_SECRET_3c4d',
      message: 'LEGACY_APPROVAL_MESSAGE_SECRET_5e6f',
      question: 'LEGACY_APPROVAL_QUESTION_SECRET_7a8b',
      credential: 'sk-proj-LEGACY_APPROVAL_CREDENTIAL_SECRET_9c0d',
      outputCredential: 'sk-proj-LEGACY_OUTPUT_CREDENTIAL_SECRET_2e3f',
      reasoning: 'LEGACY_REASONING_SECRET_4a5b',
    }
    const leaked = events.append({
      boardId,
      kind: 'driver.tool',
      source: 'codex',
      payload: {
        seq: 41,
        data: sentinels.message,
        metadata: {
          provider: 'codex',
          nativeMethod: 'item/commandExecution/requestApproval',
          method: 'item/commandExecution/requestApproval',
          native: {
            command: sentinels.command,
            path: sentinels.path,
            credential: sentinels.credential,
          },
          approval: true,
          kind: 'approval',
          approvalKind: 'command',
          questions: [{ id: 'secret', question: sentinels.question }],
        },
      },
    })
    const ordinary = events.append({
      boardId,
      kind: 'driver.tool',
      source: 'codex',
      payload: {
        seq: 42,
        data: 'ORDINARY_TOOL_EVENT_MUST_REMAIN',
        metadata: {
          nativeMethod: 'item/commandExecution/outputDelta',
          native: { output: sentinels.command },
        },
      },
    })
    const output = events.append({
      boardId,
      kind: 'driver.output',
      source: 'codex',
      payload: {
        seq: 43,
        data: `Visible answer using ${sentinels.outputCredential}`,
        metadata: {
          nativeMethod: 'item/agentMessage/delta',
          native: { delta: `Visible answer using ${sentinels.outputCredential}` },
        },
      },
    })
    const reasoningMethods = [
      'item/reasoning/summaryTextDelta',
      'item/reasoning/summaryPartAdded',
      'item/reasoning/textDelta',
    ]
    const reasoning = reasoningMethods.map((method, index) => events.append({
      boardId,
      kind: 'driver.status',
      source: 'codex',
      payload: {
        seq: 44 + index,
        data: `${sentinels.reasoning}:${method}`,
        metadata: index === 1
          ? {
              nativeMethod: 'future/non-sensitive',
              method,
              native: { delta: sentinels.reasoning },
            }
          : {
              [index === 0 ? 'nativeMethod' : 'method']: method,
              native: { delta: sentinels.reasoning },
            },
      },
    }))
    const nonDriver = events.append({
      boardId,
      kind: 'audit.note',
      source: 'test',
      payload: { data: 'NON_DRIVER_EVENT_MUST_REMAIN' },
    })
    db.prepare("DELETE FROM os_schema_migrations WHERE id='011-managed-driver-event-redaction'").run()

    applyAgentOsMigrations(db)
    const firstPass = db.prepare('SELECT payload FROM os_events WHERE id=?').get(leaked.id) as { payload: string }
    db.prepare("DELETE FROM os_schema_migrations WHERE id='011-managed-driver-event-redaction'").run()
    applyAgentOsMigrations(db)
    const secondPass = db.prepare('SELECT payload FROM os_events WHERE id=?').get(leaked.id) as { payload: string }

    expect(JSON.parse(firstPass.payload)).toEqual({
      seq: 41,
      data: 'Codex command approval requested',
      metadata: {
        approval: true,
        kind: 'approval',
        approvalKind: 'command',
        approvalPayloadState: 'withheld',
      },
    })
    expect(secondPass.payload).toBe(firstPass.payload)
    const driverPayloads = (db.prepare("SELECT payload FROM os_events WHERE kind GLOB 'driver.*'")
      .all() as Array<{ payload: string }>).map((row) => row.payload).join('\n')
    for (const sentinel of Object.values(sentinels)) expect(driverPayloads).not.toContain(sentinel)
    expect(JSON.parse((db.prepare('SELECT payload FROM os_events WHERE id=?').get(ordinary.id) as { payload: string }).payload))
      .toEqual({
        data: 'ORDINARY_TOOL_EVENT_MUST_REMAIN',
        metadata: {
          nativeMethod: 'item/commandExecution/outputDelta',
          rawPayloadState: 'withheld',
        },
        seq: 42,
      })
    expect(JSON.parse((db.prepare('SELECT payload FROM os_events WHERE id=?').get(output.id) as { payload: string }).payload))
      .toMatchObject({
        data: 'Visible answer using [REDACTED]',
        metadata: {
          nativeMethod: 'item/agentMessage/delta',
          rawPayloadState: 'withheld',
          redactionState: 'redacted',
        },
      })
    for (const event of reasoning) {
      expect(JSON.parse((db.prepare('SELECT payload FROM os_events WHERE id=?').get(event.id) as { payload: string }).payload))
        .toMatchObject({
          data: 'Codex reasoning withheld',
          metadata: {
            reasoning: true,
            reasoningPayloadState: 'withheld',
            rawPayloadState: 'withheld',
          },
        })
    }
    expect((db.prepare('SELECT payload FROM os_events WHERE id=?').get(nonDriver.id) as { payload: string }).payload)
      .toContain('NON_DRIVER_EVENT_MUST_REMAIN')
    expect((db.prepare('SELECT COUNT(*) AS count FROM os_schema_migrations').get() as any).count)
      .toBe(26)
    db.close()
  })

  it('upgrades a migration-003 database without rewriting legacy contract meaning', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-os-upgrade-'))
    tempDirs.push(directory)
    const file = path.join(directory, 'legacy.db')
    const db = new Database(file)
    db.pragma('foreign_keys = ON')
    db.exec(`
      CREATE TABLE boards (id INTEGER PRIMARY KEY, project_path TEXT NOT NULL, name TEXT NOT NULL);
      CREATE TABLE cards (
        id INTEGER PRIMARY KEY, board_id INTEGER NOT NULL, title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '', milestone_id INTEGER, step_order INTEGER
      );
      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY, board_id INTEGER NOT NULL, card_id INTEGER,
        status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE jobs (
        id TEXT PRIMARY KEY, board_id INTEGER, card_id INTEGER, workspace_id TEXT,
        provider TEXT NOT NULL DEFAULT 'claude'
      );
      CREATE TABLE agent_sessions (
        id TEXT PRIMARY KEY,
        agent_id INTEGER,
        workspace_id TEXT,
        provider TEXT NOT NULL DEFAULT 'claude',
        external_id TEXT,
        model TEXT,
        status TEXT NOT NULL DEFAULT 'starting',
        context_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE os_events (
        id TEXT PRIMARY KEY, board_id INTEGER NOT NULL, workspace_id TEXT, card_id INTEGER,
        session_id TEXT, process_id TEXT, kind TEXT NOT NULL, source TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE task_contracts (
        card_id INTEGER PRIMARY KEY, objective TEXT NOT NULL,
        acceptance_criteria TEXT NOT NULL DEFAULT '[]', dependencies TEXT NOT NULL DEFAULT '[]',
        base_ref TEXT, verify_commands TEXT NOT NULL DEFAULT '[]', budget_tokens INTEGER,
        budget_cents INTEGER, priority INTEGER NOT NULL DEFAULT 0, policy_id TEXT,
        workspace_id TEXT, updated_at TEXT NOT NULL
      );
      CREATE TABLE os_schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')));
      INSERT INTO os_schema_migrations (id) VALUES
        ('001-agent-os-kernel'), ('002-runtime-hardening'), ('003-provider-session-ownership');
      INSERT INTO boards (id, project_path, name) VALUES (1, '/legacy', 'legacy');
      INSERT INTO cards (id, board_id, title, description) VALUES (1, 1, 'Old task', 'Preserve old meaning');
      INSERT INTO jobs (id, board_id, card_id, workspace_id, provider)
        VALUES ('legacy-job', 1, 1, NULL, 'claude');
      INSERT INTO task_contracts
        (card_id, objective, acceptance_criteria, dependencies, base_ref, verify_commands, priority, updated_at)
        VALUES (1, 'Preserve old meaning', '["old criterion"]', '[]', 'HEAD', '["npm test"]', 0,
          '2026-07-22T00:00:00.000Z');
    `)
    installLegacyCompatibilityFixtureTables(db)
    const legacyCriteria: unknown[] = [
      'old criterion', 42, true, false, null, ['nested', 7], { foo: 'bar' },
      { text: 12, required: 'legacy' },
      { id: 'custom-id', text: 'Custom criterion', required: false, metadata: { owner: 'legacy' } },
      ...Array.from({ length: 205 }, (_, index) => index),
    ]
    db.prepare('UPDATE task_contracts SET acceptance_criteria=? WHERE card_id=1')
      .run(JSON.stringify(legacyCriteria))

    applyAgentOsMigrations(db)
    applyAgentOsMigrations(db)

    expect((db.prepare('SELECT COUNT(*) AS count FROM os_schema_migrations').get() as any).count).toBe(26)
    expect(db.prepare('SELECT provider, driver_id, effort, access_profile, idempotency_key FROM jobs WHERE id=?')
      .get('legacy-job')).toEqual({
        provider: 'claude', driver_id: 'claude', effort: null,
        access_profile: 'workspace_write', idempotency_key: null,
      })
    const contract = new TaskContractService(db).getOrCreate(1)
    expect(contract).toMatchObject({ objective: 'Preserve old meaning', version: 1, verify_commands: ['npm test'] })
    expect(contract.deliverables).toEqual([expect.objectContaining({ id: expect.any(String), required: true })])
    expect(contract.acceptance_criteria).toHaveLength(legacyCriteria.length)
    expect(contract.acceptance_criteria.slice(0, 9)).toEqual([
      expect.objectContaining({ id: expect.any(String), text: 'old criterion', required: true }),
      expect.objectContaining({ text: '42', metadata: { legacy_value: 42 } }),
      expect.objectContaining({ text: 'true', metadata: { legacy_value: true } }),
      expect.objectContaining({ text: 'false', metadata: { legacy_value: false } }),
      expect.objectContaining({ text: 'null', metadata: { legacy_value: null } }),
      expect.objectContaining({ text: '["nested",7]' }),
      expect.objectContaining({ text: '{"foo":"bar"}' }),
      expect.objectContaining({ text: '{"required":"legacy","text":12}', required: true }),
      expect.objectContaining({ id: 'custom-id', text: 'Custom criterion', required: false,
        metadata: { owner: 'legacy' } }),
    ])
    expect(new Set(contract.acceptance_criteria.map((item) => item.id)).size).toBe(legacyCriteria.length)
    expect(new TaskContractService(db).getOrCreate(1).acceptance_criteria.map((item) => item.id))
      .toEqual(contract.acceptance_criteria.map((item) => item.id))
    expect(JSON.parse((db.prepare('SELECT acceptance_criteria FROM task_contracts WHERE card_id=1').get() as any)
      .acceptance_criteria)[0]).toMatchObject({ id: contract.acceptance_criteria[0].id, text: 'old criterion' })
    const assignments = new JobAssignmentService(db)
    expect(assignments.current(1)).toBeNull()
    db.close()
  })

  it('upgrades populated migration-004 report revisions and cascades card deletion', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-os-revision-upgrade-'))
    tempDirs.push(directory)
    const file = path.join(directory, 'legacy-revisions.db')
    const db = new Database(file)
    db.pragma('foreign_keys = ON')
    db.exec(`
      CREATE TABLE boards (id INTEGER PRIMARY KEY, project_path TEXT NOT NULL, name TEXT NOT NULL);
      CREATE TABLE cards (
        id INTEGER PRIMARY KEY, board_id INTEGER NOT NULL, title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '', milestone_id INTEGER, step_order INTEGER
      );
      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY, board_id INTEGER NOT NULL, card_id INTEGER,
        status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE jobs (
        id TEXT PRIMARY KEY, board_id INTEGER, card_id INTEGER, workspace_id TEXT,
        provider TEXT NOT NULL DEFAULT 'claude'
      );
      CREATE TABLE agent_sessions (
        id TEXT PRIMARY KEY,
        agent_id INTEGER,
        workspace_id TEXT,
        provider TEXT NOT NULL DEFAULT 'claude',
        external_id TEXT,
        model TEXT,
        status TEXT NOT NULL DEFAULT 'starting',
        context_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE os_events (
        id TEXT PRIMARY KEY, board_id INTEGER NOT NULL, workspace_id TEXT, card_id INTEGER,
        session_id TEXT, process_id TEXT, kind TEXT NOT NULL, source TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE task_contracts (
        card_id INTEGER PRIMARY KEY, objective TEXT NOT NULL,
        acceptance_criteria TEXT NOT NULL DEFAULT '[]', dependencies TEXT NOT NULL DEFAULT '[]',
        base_ref TEXT, verify_commands TEXT NOT NULL DEFAULT '[]', budget_tokens INTEGER,
        budget_cents INTEGER, priority INTEGER NOT NULL DEFAULT 0, policy_id TEXT,
        workspace_id TEXT, updated_at TEXT NOT NULL
      );
      CREATE TABLE os_schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')));
      INSERT INTO os_schema_migrations (id) VALUES
        ('001-agent-os-kernel'), ('002-runtime-hardening'), ('003-provider-session-ownership'),
        ('005-delivery-report-revision-cascade');
      INSERT INTO boards (id, project_path, name) VALUES (1, '/legacy-revisions', 'legacy revisions');
      INSERT INTO cards (id, board_id, title, description) VALUES (1, 1, 'Old report', 'Preserve revisions');
    `)
    installLegacyCompatibilityFixtureTables(db)

    applyAgentOsMigrations(db)
    db.prepare("DELETE FROM os_schema_migrations WHERE id='005-delivery-report-revision-cascade'").run()
    const at = '2026-07-22T00:00:00.000Z'
    db.prepare(`INSERT INTO delivery_reports
      (id, lineage_id, parent_report_id, sequence, board_id, card_id, status, asked_snapshot,
       created_by, created_at, updated_at)
      VALUES ('report-1', 'report-1', NULL, 1, 1, 1, 'rejected', '{}', 'agent', ?, ?),
             ('report-2', 'report-1', 'report-1', 2, 1, 1, 'draft', '{}', 'agent', ?, ?)`)
      .run(at, at, at, at)
    db.prepare(`INSERT INTO delivery_criterion_results
      (report_id, criterion_id, outcome, evidence_refs, actor, created_at, updated_at)
      VALUES ('report-1', 'criterion-1', 'missed', '[]', 'reviewer', ?, ?)`).run(at, at)

    applyAgentOsMigrations(db)

    expect((db.prepare('SELECT COUNT(*) AS count FROM delivery_reports').get() as any).count).toBe(2)
    expect((db.prepare('SELECT COUNT(*) AS count FROM delivery_criterion_results').get() as any).count).toBe(1)
    const parentForeignKey = (db.prepare("PRAGMA foreign_key_list('delivery_reports')").all() as any[])
      .find((row) => row.from === 'parent_report_id')
    expect(parentForeignKey).toMatchObject({ table: 'delivery_reports', on_delete: 'CASCADE' })
    expect(() => db.prepare('DELETE FROM cards WHERE id=1').run()).not.toThrow()
    expect((db.prepare('SELECT COUNT(*) AS count FROM delivery_reports').get() as any).count).toBe(0)
    expect((db.prepare('SELECT COUNT(*) AS count FROM delivery_criterion_results').get() as any).count).toBe(0)
    expect((db.prepare('SELECT COUNT(*) AS count FROM os_schema_migrations').get() as any).count).toBe(26)
    db.close()
  })

  it('uses event ids as no-gap incremental cursors even when timestamps match', () => {
    const db = openDb(':memory:')
    const boardId = Number(db.prepare("INSERT INTO boards (project_path, name) VALUES ('/p', 'p')").run().lastInsertRowid)
    const events = new EventStore(db)
    const at = '2026-07-19T12:00:00.000Z'
    const first = events.append({ boardId, kind: 'one', source: 'test', createdAt: at })
    const second = events.append({ boardId, kind: 'two', source: 'test', createdAt: at })
    const third = events.append({ boardId, kind: 'three', source: 'test', createdAt: at })

    expect(events.listBoard(boardId).map((event) => event.id)).toEqual([third.id, second.id, first.id])
    expect(events.listBoard(boardId, { after: first.id }).map((event) => event.id)).toEqual([second.id, third.id])
    expect(() => events.listBoard(boardId, { after: 'not-a-cursor' })).toThrow(/cursor/)
  })

  it('stores causal metadata and idempotently replays the same event', () => {
    const db = openDb(':memory:')
    const boardId = Number(db.prepare("INSERT INTO boards (project_path, name) VALUES ('/events', 'events')")
      .run().lastInsertRowid)
    const events = new EventStore(db)
    const first = events.append({
      boardId,
      actor: { type: 'operator', id: 'operator-1' },
      kind: 'job.queued',
      source: 'test',
      jobId: 'job-1',
      contractId: 'card:1:v1',
      correlationId: 'correlation-1',
      causationId: 'request-1',
      idempotencyKey: 'job:job-1:queued',
      eventVersion: 2,
      payload: { provider: 'codex', priority: 1 },
    })
    const replay = events.append({
      boardId,
      actor: { type: 'operator', id: 'operator-1' },
      kind: 'job.queued',
      source: 'test',
      jobId: 'job-1',
      contractId: 'card:1:v1',
      correlationId: 'correlation-1',
      causationId: 'request-1',
      idempotencyKey: 'job:job-1:queued',
      eventVersion: 2,
      payload: { priority: 1, provider: 'codex' },
    })

    expect(replay.id).toBe(first.id)
    expect(first).toMatchObject({
      actor_type: 'operator', actor_id: 'operator-1',
      job_id: 'job-1', contract_id: 'card:1:v1', correlation_id: 'correlation-1', causation_id: 'request-1',
      idempotency_key: 'job:job-1:queued', event_version: 2,
    })
    for (const override of [
      { correlationId: 'different-correlation' },
      { causationId: 'different-causation' },
      { actor: { type: 'operator', id: 'operator-2' } },
    ]) {
      expect(() => events.append({
        boardId,
        actor: { type: 'operator', id: 'operator-1' },
        kind: 'job.queued',
        source: 'test',
        jobId: 'job-1',
        contractId: 'card:1:v1',
        correlationId: 'correlation-1',
        causationId: 'request-1',
        idempotencyKey: 'job:job-1:queued',
        eventVersion: 2,
        payload: { provider: 'codex', priority: 1 },
        ...override,
      })).toThrow(/different event/)
    }
    expect(() => events.append({
      boardId, kind: 'job.blocked', source: 'test', jobId: 'job-1',
      idempotencyKey: 'job:job-1:queued', payload: { error: 'different' },
    })).toThrow(/different event/)
    expect(() => events.append({
      boardId, kind: 'job.queued', source: 'test', jobId: 'job-1', contractId: 'card:1:v1',
      idempotencyKey: 'job:job-1:queued', eventVersion: 3, payload: { provider: 'codex', priority: 1 },
    })).toThrow(/different event/)
  })
})
