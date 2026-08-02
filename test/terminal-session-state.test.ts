import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openDb } from '../src/db.js'
import {
  AGENT_OS_TERMINAL_SESSION_STATE_MIGRATION_ID,
  applyAgentOsMigrations,
} from '../src/agent-os/migrations.js'
import {
  TerminalSessionStateService,
} from '../src/agent-os/terminal-session-state.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const seed = (db: ReturnType<typeof openDb>) => {
  const board = Number(db.prepare(`INSERT INTO boards (project_path, name)
    VALUES ('/terminal-state', 'terminal state')`).run().lastInsertRowid)
  db.prepare(`INSERT INTO workspaces (id, board_id, name, kind, root_path, status)
    VALUES ('workspace-1', ?, 'one', 'shared', '/terminal-state', 'active')`).run(board)
  db.prepare(`INSERT INTO workspaces (id, board_id, name, kind, root_path, status)
    VALUES ('workspace-2', ?, 'two', 'shared', '/terminal-state', 'active')`).run(board)
  db.prepare(`INSERT INTO processes (
      id, workspace_id, name, command, cwd, status, cols, rows, restartable, recipe_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'process-1',
    'workspace-1',
    'shell',
    '/bin/zsh -l',
    '/terminal-state',
    'lost',
    143,
    47,
    1,
    JSON.stringify({
      workspaceId: 'workspace-1',
      name: 'shell',
      command: '/bin/zsh',
      args: ['-l'],
      shell: false,
      cwd: '/terminal-state',
      env: {},
      cols: 143,
      rows: 47,
      restartable: true,
    }),
  )
  db.prepare(`INSERT INTO processes (id, workspace_id, name, command, cwd, status)
    VALUES ('process-2', 'workspace-2', 'other', 'pwd', '/terminal-state', 'lost')`).run()
  db.prepare(`INSERT INTO agent_sessions (
      id, workspace_id, provider, status, context_json, created_at, updated_at
    ) VALUES ('session-1', 'workspace-1', 'shell', 'lost', '{}', datetime('now'), datetime('now'))`).run()
  db.prepare(`INSERT INTO agent_sessions (
      id, workspace_id, provider, status, context_json, created_at, updated_at
    ) VALUES ('session-2', 'workspace-2', 'shell', 'lost', '{}', datetime('now'), datetime('now'))`).run()
}

const service = (db: ReturnType<typeof openDb>) => new TerminalSessionStateService(db, {
  digestKey: Buffer.alloc(32, 7),
  now: () => '2026-08-02T12:00:00.000Z',
  id: (() => {
    let next = 0
    return () => `history-${++next}`
  })(),
})

describe('durable terminal session state', () => {
  it('registers the additive migration with its exact schema inventory and reopens idempotently', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'terminal-session-migration-'))
    roots.push(root)
    const database = path.join(root, 'orchestra.db')
    let db = openDb(database)
    expect(db.prepare('SELECT id FROM os_schema_migrations WHERE id=?')
      .get(AGENT_OS_TERMINAL_SESSION_STATE_MIGRATION_ID)).toEqual({
      id: AGENT_OS_TERMINAL_SESSION_STATE_MIGRATION_ID,
    })
    expect(db.prepare(`SELECT type, name FROM sqlite_master
      WHERE name IN (
        'terminal_workspace_state', 'terminal_command_history',
        'idx_terminal_command_history_process', 'idx_terminal_command_history_session',
        'terminal_workspace_state_process_insert_guard',
        'terminal_workspace_state_process_update_guard',
        'terminal_command_history_scope_insert_guard',
        'terminal_command_history_immutable_guard'
      ) ORDER BY type, name`).all()).toHaveLength(8)
    db.close()
    db = openDb(database)
    expect(db.prepare(`SELECT COUNT(*) AS count FROM os_schema_migrations
      WHERE id=?`).get(AGENT_OS_TERMINAL_SESSION_STATE_MIGRATION_ID)).toEqual({ count: 1 })
    db.close()
  })

  it('upgrades a Lane-D database with the legacy 030 terminal marker without losing state', () => {
    const db = openDb(':memory:')
    seed(db)
    service(db).selectProcess('workspace-1', 'process-1')
    const retained = db.prepare(`SELECT * FROM terminal_workspace_state
      WHERE workspace_id='workspace-1'`).get()

    db.prepare(`DELETE FROM os_schema_migrations
      WHERE id IN (
        '030-delivery-collaboration-trackbook',
        '031-knowledge-management',
        '032-discussions-domain',
        '033-teams-planning-conflicts',
        '034-team-collaboration-review',
        '035-delivery-shipment-integrity',
        '036-knowledge-context-use-actual-evidence',
        '037-delivery-autoship-intents',
        '038-delivery-autoship-worktree-identity',
        '039-terminal-session-state'
      )`).run()
    db.prepare(`INSERT INTO os_schema_migrations (id)
      VALUES ('030-terminal-session-state')`).run()

    applyAgentOsMigrations(db)
    applyAgentOsMigrations(db)

    const integratedIds = db.prepare(`SELECT id, COUNT(*) AS count
      FROM os_schema_migrations
      WHERE id IN (
        '030-delivery-collaboration-trackbook',
        '031-knowledge-management',
        '032-discussions-domain',
        '033-teams-planning-conflicts',
        '034-team-collaboration-review',
        '035-delivery-shipment-integrity',
        '036-knowledge-context-use-actual-evidence',
        '037-delivery-autoship-intents',
        '038-delivery-autoship-worktree-identity',
        '039-terminal-session-state'
      )
      GROUP BY id ORDER BY id`).all()
    expect(integratedIds).toEqual([
      { id: '030-delivery-collaboration-trackbook', count: 1 },
      { id: '031-knowledge-management', count: 1 },
      { id: '032-discussions-domain', count: 1 },
      { id: '033-teams-planning-conflicts', count: 1 },
      { id: '034-team-collaboration-review', count: 1 },
      { id: '035-delivery-shipment-integrity', count: 1 },
      { id: '036-knowledge-context-use-actual-evidence', count: 1 },
      { id: '037-delivery-autoship-intents', count: 1 },
      { id: '038-delivery-autoship-worktree-identity', count: 1 },
      { id: '039-terminal-session-state', count: 1 },
    ])
    expect(db.prepare(`SELECT COUNT(*) AS count FROM os_schema_migrations
      WHERE id='030-terminal-session-state'`).get()).toEqual({ count: 1 })
    expect(db.prepare(`SELECT * FROM terminal_workspace_state
      WHERE workspace_id='workspace-1'`).get()).toEqual(retained)
    db.close()
  })

  it('fails closed when a legacy 030 terminal marker has an incomplete schema', () => {
    const db = openDb(':memory:')
    db.prepare(`DELETE FROM os_schema_migrations
      WHERE id >= '030-'`).run()
    db.prepare(`INSERT INTO os_schema_migrations (id)
      VALUES ('030-terminal-session-state')`).run()
    db.exec('DROP TRIGGER terminal_command_history_immutable_guard')

    expect(() => applyAgentOsMigrations(db))
      .toThrow(/039-terminal-session-state found incomplete 030-terminal-session-state schema/)
    expect(db.prepare(`SELECT COUNT(*) AS count FROM os_schema_migrations
      WHERE id='039-terminal-session-state'`).get()).toEqual({ count: 0 })
    db.close()
  })

  it('persists exact geometry, restart availability, and selected process across database restart', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'terminal-session-state-'))
    roots.push(root)
    const database = path.join(root, 'orchestra.db')
    let db = openDb(database)
    seed(db)
    service(db).selectProcess('workspace-1', 'process-1')
    db.close()

    db = openDb(database)
    const snapshot = service(db).restartSnapshot('workspace-1')
    expect(snapshot).toEqual({
      workspaceId: 'workspace-1',
      selectedProcessId: 'process-1',
      processes: [{
        id: 'process-1',
        name: 'shell',
        command: '/bin/zsh -l',
        cwd: '/terminal-state',
        status: 'lost',
        cols: 143,
        rows: 47,
        restartable: true,
        restartRecipeAvailable: true,
      }],
    })
    db.close()
  })

  it('rejects cross-workspace selection and history scope', () => {
    const db = openDb(':memory:')
    seed(db)
    const state = service(db)

    expect(() => state.selectProcess('workspace-1', 'process-2'))
      .toThrow(/selected terminal process must belong to the workspace/)
    expect(() => state.recordCommand({
      workspaceId: 'workspace-1',
      processId: 'process-1',
      sessionId: 'session-2',
      command: 'pwd',
    })).toThrow(/terminal history session must belong to the workspace/)
    state.recordCommand({
      workspaceId: 'workspace-1',
      processId: 'process-1',
      sessionId: 'session-1',
      command: 'pwd',
    })
    expect(() => db.prepare(`UPDATE terminal_command_history
      SET projected_text='rewritten' WHERE id='history-2'`).run())
      .toThrow(/terminal command history is immutable/)
    db.close()
  })

  it('stores no submitted command text by default and redacts opt-in projections', () => {
    const db = openDb(':memory:')
    seed(db)
    const state = service(db)
    const secret = 'sentinel-secret-value-1234567890'

    const defaultRecord = state.recordCommand({
      workspaceId: 'workspace-1',
      processId: 'process-1',
      sessionId: 'session-1',
      command: `export OPENAI_API_KEY=${secret}`,
    })
    expect(defaultRecord).toMatchObject({
      seq: 1,
      retention: 'hash_only',
      projectedText: null,
      redactionState: 'withheld',
    })
    expect(defaultRecord.commandDigest).toMatch(/^[0-9a-f]{64}$/)

    const projected = state.recordCommand({
      workspaceId: 'workspace-1',
      processId: 'process-1',
      sessionId: 'session-1',
      command: `curl -H 'Authorization: Bearer ${secret}' https://example.invalid`,
      retention: 'redacted_text',
    })
    expect(projected).toMatchObject({
      seq: 2,
      retention: 'redacted_text',
      redactionState: 'redacted',
      redactions: 1,
    })
    expect(projected.projectedText).toContain('[REDACTED]')
    expect(projected.projectedText).not.toContain(secret)

    const serialized = JSON.stringify(db.prepare('SELECT * FROM terminal_command_history').all())
    expect(serialized).not.toContain(secret)
    expect(serialized).not.toContain('export OPENAI_API_KEY')
    expect(state.listHistory({ workspaceId: 'workspace-1', sessionId: 'session-1' }))
      .toHaveLength(2)
    db.close()
  })

  it('allows the declared session delete lifecycle without making history mutable', () => {
    const db = openDb(':memory:')
    seed(db)
    const state = service(db)
    state.recordCommand({
      workspaceId: 'workspace-1',
      processId: 'process-1',
      sessionId: 'session-1',
      command: 'pwd',
    })

    expect(() => db.prepare("DELETE FROM agent_sessions WHERE id='session-1'").run())
      .not.toThrow()
    expect(db.prepare("SELECT session_id FROM terminal_command_history WHERE id='history-1'").get())
      .toEqual({ session_id: null })
    expect(() => db.prepare("UPDATE terminal_command_history SET source='driver' WHERE id='history-1'").run())
      .toThrow(/terminal command history is immutable/)
    db.close()
  })
})
