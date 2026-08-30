import { describe, expect, it } from 'vitest'
import { openDb } from '../src/db.js'
import { ensureLocalOrgBoard } from '../src/org-sync/local-board-state.js'

describe('local org board naming', () => {
  it('names a new mirror board after the organization, not its id', () => {
    const db = openDb(':memory:')
    const boardId = ensureLocalOrgBoard(db, 'org_x', '/org-x', "Armin's Organization")
    expect((db.prepare('SELECT name FROM boards WHERE id=?').get(boardId) as any).name)
      .toBe("Armin's Organization")
    db.close()
  })

  it('renames a default-named board once the name is known, but never a deliberate rename', () => {
    const db = openDb(':memory:')
    const boardId = ensureLocalOrgBoard(db, 'org_x', '/org-x')
    expect((db.prepare('SELECT name FROM boards WHERE id=?').get(boardId) as any).name)
      .toBe('Organization org_x')

    ensureLocalOrgBoard(db, 'org_x', '/org-x', 'Proper Name')
    expect((db.prepare('SELECT name FROM boards WHERE id=?').get(boardId) as any).name)
      .toBe('Proper Name')

    db.prepare('UPDATE boards SET name=? WHERE id=?').run('My Custom Name', boardId)
    ensureLocalOrgBoard(db, 'org_x', '/org-x', 'Proper Name')
    expect((db.prepare('SELECT name FROM boards WHERE id=?').get(boardId) as any).name)
      .toBe('My Custom Name')
    db.close()
  })
})
