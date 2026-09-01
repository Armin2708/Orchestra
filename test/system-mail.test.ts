import { describe, expect, it } from 'vitest'
import { openDb } from '../src/db.js'
import { insertSystemMail } from '../src/system-mail.js'

describe('insertSystemMail', () => {
  it('inserts operator mail with no agent sender, visible the same way agent-sent mail is', () => {
    const db = openDb(':memory:')
    const boardId = Number(db.prepare(
      `INSERT INTO boards (project_path, name) VALUES ('/p', 'p')`,
    ).run().lastInsertRowid)

    insertSystemMail(db, boardId, {
      subject: 'Codex CLI drifted off the pin',
      body: 'Codex updated to 0.150.0; pinned to 0.146.0.',
      mailType: 'blocker',
    })

    const row = db.prepare(`SELECT * FROM messages WHERE board_id = ?`).get(boardId) as any
    expect(row).toMatchObject({
      to_human: 1,
      from_agent_id: null,
      to_agent_id: null,
      kind: 'announce',
      subject: 'Codex CLI drifted off the pin',
      mail_type: 'blocker',
      body: 'Codex updated to 0.150.0; pinned to 0.146.0.',
    })
  })

  it('truncates an overlong subject to 200 chars, matching the HTTP mail path', () => {
    const db = openDb(':memory:')
    const boardId = Number(db.prepare(
      `INSERT INTO boards (project_path, name) VALUES ('/p', 'p')`,
    ).run().lastInsertRowid)

    insertSystemMail(db, boardId, { subject: 'x'.repeat(250), body: 'b', mailType: 'fyi' })

    const row = db.prepare(`SELECT subject FROM messages WHERE board_id = ?`).get(boardId) as any
    expect(row.subject).toHaveLength(200)
  })
})
