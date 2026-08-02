import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { installKnowledgeManagementSchema } from '../src/agent-os/knowledge-management-migration.js'
import { openDb } from '../src/db.js'

const temporary: string[] = []
afterEach(() => { for (const item of temporary.splice(0)) fs.rmSync(item, { recursive: true, force: true }) })

describe('Knowledge management additive schema', () => {
  it('fails closed when a migration-owned table was pre-created with a different shape', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-kno-schema-'))
    temporary.push(directory)
    const db = openDb(path.join(directory, 'db.sqlite'))
    db.exec('DROP TABLE knowledge_freshness_observations')
    db.exec('CREATE TABLE knowledge_freshness_observations (id TEXT PRIMARY KEY)')
    expect(() => installKnowledgeManagementSchema(db)).toThrow(/schema is invalid/u)
    db.close()
  })
})
