import { describe, expect, it } from 'vitest'
import { openDb } from '../src/db.js'
import {
  AGENT_OS_KNOWLEDGE_RETRIEVAL_MIGRATION_ID,
  AGENT_OS_DOMAIN_SERVICE_NAMES,
  KnowledgeService,
  createAgentOsDomainServiceBoundaries,
} from '../src/agent-os/index.js'
import { JobScheduler } from '../src/agent-os/scheduler.js'

describe('Lane 3 Knowledge Compiler central integration', () => {
  it('registers the additive retrieval schema as migration 025', () => {
    const db = openDb(':memory:')
    try {
      expect(AGENT_OS_KNOWLEDGE_RETRIEVAL_MIGRATION_ID)
        .toBe('025-knowledge-retrieval')
      expect(db.prepare(`SELECT id FROM os_schema_migrations
        ORDER BY rowid DESC LIMIT 1`).get()).toEqual({
        id: AGENT_OS_KNOWLEDGE_RETRIEVAL_MIGRATION_ID,
      })
      const objects = db.prepare(`SELECT type, name FROM sqlite_master
        WHERE name IN (
          'knowledge_retrieval_schema',
          'knowledge_retrieval_documents',
          'knowledge_retrieval_documents_source',
          'knowledge_retrieval_index_state',
          'knowledge_retrieval_fts'
        ) ORDER BY name`).all()
      expect(objects).toEqual([
        { type: 'table', name: 'knowledge_retrieval_documents' },
        { type: 'index', name: 'knowledge_retrieval_documents_source' },
        { type: 'table', name: 'knowledge_retrieval_fts' },
        { type: 'table', name: 'knowledge_retrieval_index_state' },
        { type: 'table', name: 'knowledge_retrieval_schema' },
      ])
    } finally {
      db.close()
    }
  })

  it('publishes ingestion and retrieval through the canonical knowledge boundary', () => {
    const db = openDb(':memory:')
    try {
      const scheduler = new JobScheduler(db)
      const boundaries = createAgentOsDomainServiceBoundaries(db, { scheduler })

      expect(Object.keys(boundaries)).toEqual(AGENT_OS_DOMAIN_SERVICE_NAMES)
      expect(boundaries.knowledge.implementation_state).toBe('canonical')
      expect(boundaries.knowledge.service).toBeInstanceOf(KnowledgeService)
      expect(boundaries.knowledge.owns).toEqual(expect.arrayContaining([
        'verified repository evidence ingestion',
        'deterministic retrieval synchronization and query',
      ]))
      expect(boundaries.knowledge.excludes).toEqual(expect.arrayContaining([
        'managed prompt injection',
        'automatic freshness or promotion',
      ]))
      expect(boundaries.knowledge.excludes).not.toContain('retrieval and ranking')
      expect(boundaries.knowledge.service.ingestStructural).toBeTypeOf('function')
      expect(boundaries.knowledge.service.ingestGitContext).toBeTypeOf('function')
      expect(boundaries.knowledge.service.ingestVerifiedDelivery).toBeTypeOf('function')
      expect(boundaries.knowledge.service.synchronizeRetrievalIndex).toBeTypeOf('function')
      expect(boundaries.knowledge.service.rebuildRetrievalIndex).toBeTypeOf('function')
      expect(boundaries.knowledge.service.retrieve).toBeTypeOf('function')
    } finally {
      db.close()
    }
  })
})
