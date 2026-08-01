import type Database from 'better-sqlite3'
import {
  KnowledgeSourceIngestor,
  type AcceptedKnowledgeIngestionInput,
  type GitContextKnowledgeIngestionInput,
  type KnowledgeSourceIngestionReport,
  type StructuralKnowledgeIngestionInput,
  type VerifiedDeliveryKnowledgeIngestionInput,
} from './knowledge-source-ingestion.js'
import {
  rebuildKnowledgeRetrievalIndex,
  retrieveKnowledge,
  synchronizeKnowledgeRetrievalIndex,
  type KnowledgeRetrievalSyncRequest,
  type KnowledgeRetrievalSyncResult,
} from './knowledge-retrieval.js'
import type {
  KnowledgeRetrievalRequest,
  KnowledgeRetrievalResult,
} from './knowledge-retrieval-contracts.js'
import { KnowledgeStore } from './knowledge-store.js'

/**
 * Canonical Knowledge boundary: durable persistence plus verified repository
 * ingestion and deterministic local retrieval. Prompt injection, freshness
 * automation, review workflows, and promotion remain separate later phases.
 */
export class KnowledgeService extends KnowledgeStore {
  private readonly ingestor: KnowledgeSourceIngestor

  constructor(private readonly knowledgeDb: Database.Database) {
    super(knowledgeDb)
    this.ingestor = new KnowledgeSourceIngestor(knowledgeDb)
  }

  ingestAcceptedKnowledge(
    request: AcceptedKnowledgeIngestionInput,
  ): KnowledgeSourceIngestionReport {
    return this.ingestor.ingestAcceptedKnowledge(request)
  }

  ingestStructural(
    request: StructuralKnowledgeIngestionInput,
  ): KnowledgeSourceIngestionReport {
    return this.ingestor.ingestStructural(request)
  }

  ingestGitContext(
    request: GitContextKnowledgeIngestionInput,
  ): KnowledgeSourceIngestionReport {
    return this.ingestor.ingestGitContext(request)
  }

  ingestVerifiedDelivery(
    request: VerifiedDeliveryKnowledgeIngestionInput,
  ): KnowledgeSourceIngestionReport {
    return this.ingestor.ingestVerifiedDelivery(request)
  }

  synchronizeRetrievalIndex(
    request: KnowledgeRetrievalSyncRequest,
  ): KnowledgeRetrievalSyncResult {
    return synchronizeKnowledgeRetrievalIndex(this.knowledgeDb, request)
  }

  rebuildRetrievalIndex(
    request: KnowledgeRetrievalSyncRequest,
  ): KnowledgeRetrievalSyncResult {
    return rebuildKnowledgeRetrievalIndex(this.knowledgeDb, request)
  }

  retrieve(request: KnowledgeRetrievalRequest): KnowledgeRetrievalResult {
    return retrieveKnowledge(this.knowledgeDb, request)
  }
}
