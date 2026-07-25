import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { openDb } from '../src/db.js'
import { applyAgentOsMigrations } from '../src/agent-os/migrations.js'
import { AgentProfileService } from '../src/agent-os/agent-profiles.js'
import { ConversationService } from '../src/agent-os/conversations.js'
import { EventStore } from '../src/agent-os/event-store.js'
import { TaskContractService } from '../src/agent-os/task-contracts.js'

const tempDirs: string[] = []
afterEach(() => {
  for (const directory of tempDirs.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

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
    expect((first.prepare('SELECT COUNT(*) AS count FROM os_schema_migrations').get() as any).count).toBe(12)
    first.close()

    const second = openDb(file)
    const tables = new Set((second.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as any[]).map((row) => row.name))
    for (const table of ['workspaces', 'agent_sessions', 'processes', 'process_output', 'os_events', 'artifacts',
      'policies', 'task_contracts', 'attention_items', 'checkpoints', 'jobs', 'context_items', 'daemon_leases',
      'delivery_reports', 'delivery_deliverable_results', 'delivery_criterion_results', 'workspace_assignments',
      'agent_profiles', 'agent_conversations', 'conversation_events',
      'conversation_event_conflicts', 'agent_session_actions',
      'job_market_contracts', 'job_market_criteria',
      'job_market_dependencies', 'agent_home_retention_policies',
      'agent_home_retention_runs', 'agent_home_raw_artifact_archives',
      'agent_home_evidence_bundle_repairs']) {
      expect(tables.has(table), table).toBe(true)
    }
    expect((second.prepare('SELECT COUNT(*) AS count FROM os_schema_migrations').get() as any).count).toBe(12)
    expect((second.prepare("SELECT dflt_value FROM pragma_table_info('workspaces') WHERE name='status'").get() as any).dflt_value)
      .toBe("'active'")
    expect((second.prepare("SELECT dflt_value FROM pragma_table_info('processes') WHERE name='recipe_json'").get() as any).dflt_value)
      .toBe("'{}'")
    expect((second.prepare("SELECT dflt_value FROM pragma_table_info('jobs') WHERE name='spent_tokens'").get() as any).dflt_value)
      .toBe('0')
    expect((second.prepare("SELECT dflt_value FROM pragma_table_info('task_contracts') WHERE name='version'").get() as any).dflt_value)
      .toBe('1')
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
    }).count).toBe(12)
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
      .toBe(12)
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
      .toBe(12)
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
      CREATE TABLE agent_sessions (id TEXT PRIMARY KEY, workspace_id TEXT, context_json TEXT NOT NULL DEFAULT '{}');
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

    expect((db.prepare('SELECT COUNT(*) AS count FROM os_schema_migrations').get() as any).count).toBe(12)
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
    db.close()
  })

  it('upgrades populated migration-004 report revisions and cascades card deletion', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-os-revision-upgrade-'))
    tempDirs.push(directory)
    const db = new Database(path.join(directory, 'legacy-revisions.db'))
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
      CREATE TABLE agent_sessions (id TEXT PRIMARY KEY, workspace_id TEXT, context_json TEXT NOT NULL DEFAULT '{}');
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
    expect((db.prepare('SELECT COUNT(*) AS count FROM os_schema_migrations').get() as any).count).toBe(12)
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
      kind: 'job.queued',
      source: 'test',
      jobId: 'job-1',
      contractId: 'card:1:v1',
      correlationId: 'different-value-is-non-semantic-for-replay',
      causationId: 'different-value-is-non-semantic-for-replay',
      idempotencyKey: 'job:job-1:queued',
      eventVersion: 2,
      payload: { priority: 1, provider: 'codex' },
    })

    expect(replay.id).toBe(first.id)
    expect(first).toMatchObject({
      job_id: 'job-1', contract_id: 'card:1:v1', correlation_id: 'correlation-1', causation_id: 'request-1',
      idempotency_key: 'job:job-1:queued', event_version: 2,
    })
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
