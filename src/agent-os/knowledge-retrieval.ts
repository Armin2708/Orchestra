import { createHash } from 'node:crypto'
import Database from 'better-sqlite3'
import type {
  KnowledgeChunk,
  KnowledgeSource,
  KnowledgeTargetLinks,
} from './knowledge-types.js'
import {
  canonicalKnowledgeJson,
  validateKnowledgeChunk,
  validateKnowledgeSource,
} from './knowledge-contracts.js'
import {
  KNOWLEDGE_RETRIEVAL_CONTRACT_VERSION,
  knowledgeRetrievalFtsExpression,
  knowledgeRetrievalRequestHash,
  sourceVisibleToKnowledgeRetrievalRequest,
  validateKnowledgeRetrievalRequest,
  validateKnowledgeRetrievalResult,
} from './knowledge-retrieval-contracts.js'
import type {
  KnowledgeRetrievalCitation,
  KnowledgeRetrievalRequest,
  KnowledgeRetrievalResult,
} from './knowledge-retrieval-contracts.js'

const RETRIEVAL_SCHEMA_VERSION = 1
const MAX_SAFE_FTS_ROWID = 4_503_599_627_370_496
const SHA256 = /^[a-f0-9]{64}$/u
const SOURCE_ID = /^ks_[a-f0-9]{64}$/u
const CHUNK_ID = /^kc_[a-f0-9]{64}$/u
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u

const SCHEMA_OBJECTS = Object.freeze([
  'knowledge_retrieval_schema',
  'knowledge_retrieval_documents',
  'knowledge_retrieval_documents_source',
  'knowledge_retrieval_index_state',
  'knowledge_retrieval_fts',
] as const)

const INSTALL_SQL = `
  CREATE TABLE knowledge_retrieval_schema (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    schema_version INTEGER NOT NULL CHECK(schema_version=1),
    schema_fingerprint TEXT NOT NULL
      CHECK(length(schema_fingerprint)=64
        AND schema_fingerprint NOT GLOB '*[^0-9a-f]*')
  );

  CREATE TABLE knowledge_retrieval_documents (
    board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE RESTRICT,
    fts_rowid INTEGER NOT NULL UNIQUE
      CHECK(fts_rowid BETWEEN 1 AND 4503599627370496),
    source_id TEXT NOT NULL,
    chunk_id TEXT NOT NULL,
    document_fingerprint TEXT NOT NULL
      CHECK(length(document_fingerprint)=64
        AND document_fingerprint NOT GLOB '*[^0-9a-f]*'),
    PRIMARY KEY(board_id, chunk_id),
    UNIQUE(board_id, source_id, chunk_id),
    FOREIGN KEY(board_id, source_id)
      REFERENCES knowledge_sources(board_id, id) ON DELETE RESTRICT,
    FOREIGN KEY(board_id, source_id, chunk_id)
      REFERENCES knowledge_chunks(board_id, source_id, id) ON DELETE RESTRICT
  );

  CREATE INDEX knowledge_retrieval_documents_source
    ON knowledge_retrieval_documents(board_id, source_id, chunk_id);

  CREATE TABLE knowledge_retrieval_index_state (
    board_id INTEGER PRIMARY KEY REFERENCES boards(id) ON DELETE RESTRICT,
    schema_version INTEGER NOT NULL CHECK(schema_version=1),
    snapshot_sha256 TEXT NOT NULL
      CHECK(length(snapshot_sha256)=64
        AND snapshot_sha256 NOT GLOB '*[^0-9a-f]*'),
    document_count INTEGER NOT NULL CHECK(document_count>=0),
    indexed_at TEXT NOT NULL CHECK(length(indexed_at)=24)
  );

  CREATE VIRTUAL TABLE knowledge_retrieval_fts USING fts5(
    content,
    title,
    locator,
    symbol,
    tokenize='unicode61 remove_diacritics 2'
  );
`

export type KnowledgeRetrievalErrorCode =
  | 'retrieval_schema_invalid'
  | 'retrieval_source_corrupt'
  | 'retrieval_index_drift'
  | 'retrieval_scope_invalid'
  | 'retrieval_rowid_collision'
  | 'retrieval_query_failed'

const ERROR_MESSAGES: Readonly<Record<KnowledgeRetrievalErrorCode, string>> = {
  retrieval_schema_invalid: 'knowledge retrieval schema is invalid',
  retrieval_source_corrupt: 'knowledge retrieval source data is corrupt',
  retrieval_index_drift: 'knowledge retrieval index has drifted',
  retrieval_scope_invalid: 'knowledge retrieval scope is invalid',
  retrieval_rowid_collision: 'knowledge retrieval row identity collided',
  retrieval_query_failed: 'knowledge retrieval query failed',
}

/**
 * Runtime failures intentionally expose no source text, query text, SQL, or
 * user-supplied identifiers. Stable codes are safe to audit.
 */
export class KnowledgeRetrievalError extends Error {
  readonly code: KnowledgeRetrievalErrorCode

  constructor(code: KnowledgeRetrievalErrorCode) {
    super(ERROR_MESSAGES[code])
    this.name = 'KnowledgeRetrievalError'
    this.code = code
  }
}

export interface KnowledgeRetrievalSyncRequest {
  board_id: number
  indexed_at: string
}

export interface KnowledgeRetrievalSyncResult {
  board_id: number
  mode: 'incremental' | 'rebuild'
  status: 'created' | 'updated' | 'unchanged' | 'rebuilt'
  inserted_documents: number
  removed_documents: number
  document_count: number
  snapshot_sha256: string
  indexed_at: string
}

interface StoredIndexState {
  board_id: number
  schema_version: number
  snapshot_sha256: string
  document_count: number
  indexed_at: string
}

interface IndexedDocumentRow {
  board_id: number
  fts_rowid: number
  source_id: string
  chunk_id: string
  document_fingerprint: string
}

interface RetrievalDocument {
  board_id: number
  fts_rowid: number
  source: KnowledgeSource
  chunk: KnowledgeChunk
  document_fingerprint: string
  fts_content: string
  fts_title: string
  fts_locator: string
  fts_symbol: string
}

interface FtsRow {
  rowid: number
  content: string
  title: string
  locator: string
  symbol: string
}

function runtimeError(code: KnowledgeRetrievalErrorCode): never {
  throw new KnowledgeRetrievalError(code)
}

function protect<T>(
  action: () => T,
  fallback: KnowledgeRetrievalErrorCode,
): T {
  try {
    return action()
  } catch (error) {
    if (error instanceof KnowledgeRetrievalError) throw error
    runtimeError(fallback)
  }
}

function compareCodeUnits(left: string, right: string): number {
  if (left === right) return 0
  return left < right ? -1 : 1
}

function hash(domain: string, value: unknown): string {
  return createHash('sha256')
    .update(`orchestra-agent-os:knowledge-retrieval-${domain}:v1\0`, 'utf8')
    .update(canonicalKnowledgeJson(value, {
      max_depth: 16,
      max_nodes: 100_000,
      max_string_characters: 2_000_000,
      max_serialized_bytes: 8_000_000,
    }), 'utf8')
    .digest('hex')
}

function rawString(value: unknown): string {
  if (typeof value !== 'string') runtimeError('retrieval_source_corrupt')
  return value
}

function rawInteger(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > maximum) {
    runtimeError('retrieval_source_corrupt')
  }
  return Number(value)
}

function canonicalStoredJson(value: unknown): unknown {
  const serialized = rawString(value)
  try {
    const parsed = JSON.parse(serialized) as unknown
    if (canonicalKnowledgeJson(parsed, {
      max_depth: 64,
      max_nodes: 100_000,
      max_string_characters: 2_000_000,
      max_serialized_bytes: 8_000_000,
    }) !== serialized) {
      runtimeError('retrieval_source_corrupt')
    }
    return parsed
  } catch (error) {
    if (error instanceof KnowledgeRetrievalError) throw error
    runtimeError('retrieval_source_corrupt')
  }
}

function schemaFingerprint(db: Database.Database): string {
  const placeholders = SCHEMA_OBJECTS.map(() => '?').join(',')
  const rows = db.prepare(`SELECT type, name, sql FROM sqlite_master
    WHERE name IN (${placeholders}) ORDER BY name`)
    .all(...SCHEMA_OBJECTS) as Array<Record<string, unknown>>
  if (rows.length !== SCHEMA_OBJECTS.length) runtimeError('retrieval_schema_invalid')
  const expectedTypes = new Map<string, string>([
    ['knowledge_retrieval_schema', 'table'],
    ['knowledge_retrieval_documents', 'table'],
    ['knowledge_retrieval_documents_source', 'index'],
    ['knowledge_retrieval_index_state', 'table'],
    ['knowledge_retrieval_fts', 'table'],
  ])
  const retained = rows.map((row) => {
    const name = rawString(row.name)
    const type = rawString(row.type)
    const sql = rawString(row.sql)
    if (expectedTypes.get(name) !== type || sql.length === 0) {
      runtimeError('retrieval_schema_invalid')
    }
    return { name, type, sql }
  })
  return hash('schema', retained)
}

function assertPrerequisiteSchema(db: Database.Database): void {
  const rows = db.prepare(`SELECT name FROM sqlite_master
    WHERE type='table' AND name IN ('boards', 'knowledge_sources', 'knowledge_chunks')
    ORDER BY name`).all() as Array<{ name: string }>
  if (
    rows.length !== 3
    || rows[0]?.name !== 'boards'
    || rows[1]?.name !== 'knowledge_chunks'
    || rows[2]?.name !== 'knowledge_sources'
  ) {
    runtimeError('retrieval_schema_invalid')
  }
}

function assertRetrievalSchema(db: Database.Database): void {
  const fingerprint = schemaFingerprint(db)
  const row = db.prepare(`SELECT singleton, schema_version, schema_fingerprint
    FROM knowledge_retrieval_schema`).get() as Record<string, unknown> | undefined
  if (
    !row
    || rawInteger(row.singleton) !== 1
    || rawInteger(row.schema_version) !== RETRIEVAL_SCHEMA_VERSION
    || rawString(row.schema_fingerprint) !== fingerprint
    || !SHA256.test(rawString(row.schema_fingerprint))
    || Number(
      (db.prepare('SELECT COUNT(*) AS count FROM knowledge_retrieval_schema')
        .get() as { count: number }).count,
    ) !== 1
  ) {
    runtimeError('retrieval_schema_invalid')
  }
  try {
    db.prepare(
      "INSERT INTO knowledge_retrieval_fts(knowledge_retrieval_fts) VALUES ('integrity-check')",
    ).run()
  } catch {
    runtimeError('retrieval_schema_invalid')
  }
}

/**
 * Installs the additive KNO-010 schema. It is deliberately not a numbered
 * Agent OS migration so Lane 1 can place it at the correct integration point.
 * Creation is transactional; partial or incompatible pre-existing objects are
 * rejected rather than adopted.
 */
export function installKnowledgeRetrievalSchema(db: Database.Database): void {
  protect(() => {
    assertPrerequisiteSchema(db)
    const placeholders = SCHEMA_OBJECTS.map(() => '?').join(',')
    const existing = db.prepare(`SELECT name FROM sqlite_master
      WHERE name IN (${placeholders})`).all(...SCHEMA_OBJECTS) as Array<{ name: string }>
    if (existing.length === 0) {
      const install = db.transaction(() => {
        db.exec(INSTALL_SQL)
        const fingerprint = schemaFingerprint(db)
        db.prepare(`INSERT INTO knowledge_retrieval_schema
          (singleton, schema_version, schema_fingerprint) VALUES (1, ?, ?)`)
          .run(RETRIEVAL_SCHEMA_VERSION, fingerprint)
      })
      install.immediate()
    }
    assertRetrievalSchema(db)
  }, 'retrieval_schema_invalid')
}

function validateSyncRequest(value: KnowledgeRetrievalSyncRequest): KnowledgeRetrievalSyncRequest {
  if (
    value === null
    || typeof value !== 'object'
    || Array.isArray(value)
    || Reflect.ownKeys(value).length !== 2
    || !Object.prototype.hasOwnProperty.call(value, 'board_id')
    || !Object.prototype.hasOwnProperty.call(value, 'indexed_at')
    || !Number.isSafeInteger(value.board_id)
    || value.board_id < 1
    || typeof value.indexed_at !== 'string'
    || !ISO_TIMESTAMP.test(value.indexed_at)
    || new Date(value.indexed_at).toISOString() !== value.indexed_at
  ) {
    runtimeError('retrieval_scope_invalid')
  }
  return { board_id: value.board_id, indexed_at: value.indexed_at }
}

function assertBoard(db: Database.Database, boardId: number): void {
  const board = db.prepare('SELECT 1 AS present FROM boards WHERE id=?').get(boardId)
  if (!board) runtimeError('retrieval_scope_invalid')
}

function exactContractSnapshotSha256(
  row: Record<string, unknown>,
  fail: () => never,
): string {
  const array = (value: unknown): unknown[] => {
    if (typeof value !== 'string') fail()
    try {
      const parsed = JSON.parse(value) as unknown
      if (!Array.isArray(parsed)) fail()
      return parsed
    } catch {
      fail()
    }
  }
  const nullableInteger = (value: unknown): number | null => {
    if (value === null) return null
    if (!Number.isSafeInteger(value)) fail()
    return Number(value)
  }
  if (
    typeof row.objective !== 'string'
    || typeof row.updated_at !== 'string'
    || row.updated_at.length === 0
    || (row.base_ref !== null && typeof row.base_ref !== 'string')
    || (row.policy_id !== null && typeof row.policy_id !== 'string')
    || !Number.isSafeInteger(row.priority)
    || !Number.isSafeInteger(row.version)
  ) {
    fail()
  }
  const snapshot = {
    objective: row.objective,
    deliverables: array(row.deliverables),
    acceptance_criteria: array(row.acceptance_criteria),
    verify_commands: array(row.verify_commands),
    non_goals: array(row.non_goals),
    risks: array(row.risks),
    dependencies: array(row.dependencies),
    base_ref: row.base_ref,
    budget_tokens: nullableInteger(row.budget_tokens),
    budget_cents: nullableInteger(row.budget_cents),
    priority: Number(row.priority),
    policy_id: row.policy_id,
    contract_version: Number(row.version),
    contract_updated_at: row.updated_at,
  }
  return createHash('sha256')
    .update(JSON.stringify(snapshot), 'utf8')
    .digest('hex')
}

function assertTargetsAuthority(
  db: Database.Database,
  boardId: number,
  target: KnowledgeTargetLinks,
  failure: KnowledgeRetrievalErrorCode,
): void {
  const fail = (): never => runtimeError(failure)
  if (target.board_id !== boardId) fail()
  if (target.workspace_id !== null) {
    const workspace = db.prepare(`SELECT board_id, card_id FROM workspaces
      WHERE id=?`).get(target.workspace_id) as {
      board_id: number
      card_id: number | null
    } | undefined
    if (
      !workspace
      || Number(workspace.board_id) !== boardId
      || (
        workspace.card_id === null
          ? target.card_id !== null
          : Number(workspace.card_id) !== target.card_id
      )
    ) fail()
  }
  if (target.card_id !== null) {
    const card = db.prepare('SELECT board_id FROM cards WHERE id=?')
      .get(target.card_id) as { board_id: number } | undefined
    if (!card || Number(card.board_id) !== boardId) fail()
  }
  if (target.contract_ref !== null) {
    const contracts = db.prepare(`SELECT card.board_id, contract.objective,
        contract.deliverables, contract.acceptance_criteria,
        contract.verify_commands, contract.non_goals, contract.risks,
        contract.dependencies, contract.base_ref, contract.budget_tokens,
        contract.budget_cents, contract.priority, contract.policy_id,
        contract.version, contract.updated_at
      FROM task_contracts contract
      JOIN cards card ON card.id=contract.card_id
      WHERE contract.card_id=? AND contract.version=?`)
      .all(target.card_id, target.contract_version) as Array<Record<string, unknown>>
    if (
      contracts.length !== 1
      || Number(contracts[0].board_id) !== boardId
      || Number(contracts[0].version) !== target.contract_version
      || (
        target.delivery_report_id === null
        && exactContractSnapshotSha256(contracts[0], fail)
          !== target.contract_snapshot_sha256
      )
    ) fail()
  }
  if (target.job_id !== null) {
    const job = db.prepare(`SELECT board_id, card_id, workspace_id,
        contract_version, assigned_profile_id FROM jobs WHERE id=?`)
      .get(target.job_id) as {
      board_id: number
      card_id: number | null
      workspace_id: string | null
      contract_version: number | null
      assigned_profile_id: string | null
    } | undefined
    if (
      !job
      || Number(job.board_id) !== boardId
      || (target.card_id !== null && Number(job.card_id) !== target.card_id)
      || (target.workspace_id !== null && job.workspace_id !== target.workspace_id)
      || (
        target.contract_version !== null
        && Number(job.contract_version) !== target.contract_version
      )
      || (
        target.profile_id !== null
        && job.assigned_profile_id !== target.profile_id
      )
    ) fail()
  }
  if (target.profile_id !== null) {
    const profile = db.prepare('SELECT board_id FROM agent_profiles WHERE id=?')
      .get(target.profile_id) as { board_id: number } | undefined
    if (!profile || Number(profile.board_id) !== boardId) fail()
  }
  if (target.session_id !== null) {
    const session = db.prepare(`SELECT workspace.board_id, workspace.card_id,
        session.job_id, session.profile_id, session.workspace_id,
        job.card_id AS job_card_id, job.contract_version AS job_contract_version
      FROM agent_sessions session
      JOIN workspaces workspace ON workspace.id=session.workspace_id
      LEFT JOIN jobs job ON job.id=session.job_id
      WHERE session.id=?`).get(target.session_id) as {
      board_id: number
      card_id: number | null
      job_id: string | null
      profile_id: string | null
      workspace_id: string
      job_card_id: number | null
      job_contract_version: number | null
    } | undefined
    if (
      !session
      || Number(session.board_id) !== boardId
      || (target.job_id !== null && session.job_id !== target.job_id)
      || (target.profile_id !== null && session.profile_id !== target.profile_id)
      || (target.workspace_id !== null && session.workspace_id !== target.workspace_id)
      || (
        target.card_id !== null
        && (
            session.job_id !== null
              ? Number(session.job_card_id) !== target.card_id
              : (
                  session.card_id === null
                    ? target.card_id !== null
                    : Number(session.card_id) !== target.card_id
                )
          )
        )
      || (
        target.contract_version !== null
        && (
          session.job_id === null
          || Number(session.job_contract_version) !== target.contract_version
        )
      )
    ) fail()
  }
  if (target.delivery_report_id !== null) {
    const report = db.prepare(`SELECT report.board_id, report.card_id,
        report.job_id, report.session_id, report.workspace_id,
        report.asked_snapshot,
        json_extract(report.asked_snapshot, '$.contract_version')
          AS asked_contract_version,
        session.profile_id AS session_profile_id,
        job.assigned_profile_id AS job_profile_id
      FROM delivery_reports report
      LEFT JOIN agent_sessions session ON session.id=report.session_id
      LEFT JOIN jobs job ON job.id=report.job_id
      WHERE report.id=?`).get(target.delivery_report_id) as {
      board_id: number
      card_id: number
      job_id: string | null
      session_id: string | null
      workspace_id: string | null
      asked_snapshot: string
      asked_contract_version: number | null
      session_profile_id: string | null
      job_profile_id: string | null
    } | undefined
    if (
      !report
      || Number(report.board_id) !== boardId
      || (target.card_id !== null && Number(report.card_id) !== target.card_id)
      || (target.job_id !== null && report.job_id !== target.job_id)
      || (target.session_id !== null && report.session_id !== target.session_id)
      || (target.workspace_id !== null && report.workspace_id !== target.workspace_id)
      || (
        target.contract_version !== null
        && (
          Number(report.asked_contract_version) !== target.contract_version
          || typeof report.asked_snapshot !== 'string'
          || createHash('sha256')
            .update(report.asked_snapshot, 'utf8')
            .digest('hex') !== target.contract_snapshot_sha256
        )
      )
      || (
        target.profile_id !== null
        && (
          (report.session_id === null && report.job_id === null)
          || (
            report.session_id !== null
            && report.session_profile_id !== target.profile_id
          )
          || (
            report.job_id !== null
            && report.job_profile_id !== target.profile_id
          )
        )
      )
    ) fail()
  }
}

function readSources(
  db: Database.Database,
  boardId: number,
): Map<string, KnowledgeSource> {
  const rows = db.prepare(`SELECT * FROM knowledge_sources
    WHERE board_id=? ORDER BY id`).all(boardId) as Array<Record<string, unknown>>
  const output = new Map<string, KnowledgeSource>()
  for (const row of rows) {
    try {
      const raw: KnowledgeSource = {
        id: rawString(row.id),
        source_kind: rawString(row.source_kind) as KnowledgeSource['source_kind'],
        trust_class: rawString(row.trust_class) as KnowledgeSource['trust_class'],
        title: rawString(row.title),
        locator: rawString(row.locator),
        normalized_locator: rawString(row.normalized_locator),
        source_revision: rawString(row.source_revision),
        content_sha256: rawString(row.content_sha256),
        freshness_policy: rawString(
          row.freshness_policy,
        ) as KnowledgeSource['freshness_policy'],
        freshness_state: rawString(
          row.freshness_state,
        ) as KnowledgeSource['freshness_state'],
        redaction_state: rawString(
          row.redaction_state,
        ) as KnowledgeSource['redaction_state'],
        content_state: rawString(row.content_state) as KnowledgeSource['content_state'],
        ingest_state: rawString(row.ingest_state) as KnowledgeSource['ingest_state'],
        access_scope: canonicalStoredJson(
          row.access_scope_json,
        ) as KnowledgeSource['access_scope'],
        targets: canonicalStoredJson(row.targets_json) as KnowledgeSource['targets'],
        provenance: canonicalStoredJson(
          row.provenance_json,
        ) as KnowledgeSource['provenance'],
        created_at: rawString(row.created_at),
        updated_at: rawString(row.updated_at),
      }
      const source = validateKnowledgeSource(raw)
      if (
        rawInteger(row.board_id) !== boardId
        || source.targets.board_id !== boardId
        || output.has(source.id)
      ) {
        runtimeError('retrieval_source_corrupt')
      }
      assertTargetsAuthority(
        db,
        boardId,
        source.targets,
        'retrieval_source_corrupt',
      )
      output.set(source.id, source)
    } catch (error) {
      if (error instanceof KnowledgeRetrievalError) throw error
      runtimeError('retrieval_source_corrupt')
    }
  }
  return output
}

function readChunks(
  db: Database.Database,
  boardId: number,
  sources: ReadonlyMap<string, KnowledgeSource>,
): KnowledgeChunk[] {
  const rows = db.prepare(`SELECT * FROM knowledge_chunks
    WHERE board_id=? ORDER BY source_id, ordinal, id`)
    .all(boardId) as Array<Record<string, unknown>>
  const output: KnowledgeChunk[] = []
  const ordinals = new Set<string>()
  for (const row of rows) {
    try {
      const raw: KnowledgeChunk = {
        id: rawString(row.id),
        source_id: rawString(row.source_id),
        ordinal: rawInteger(row.ordinal),
        content: rawString(row.content),
        content_sha256: rawString(row.content_sha256),
        character_count: rawInteger(row.character_count),
        byte_count: rawInteger(row.byte_count),
        estimated_tokens: rawInteger(row.estimated_tokens),
        source_range: canonicalStoredJson(
          row.source_range_json,
        ) as KnowledgeChunk['source_range'],
        symbol: row.symbol_json === null
          ? null
          : canonicalStoredJson(row.symbol_json) as KnowledgeChunk['symbol'],
        created_at: rawString(row.created_at),
      }
      const chunk = validateKnowledgeChunk(raw)
      const source = sources.get(chunk.source_id)
      const ordinalKey = `${chunk.source_id}\0${chunk.ordinal}`
      if (
        rawInteger(row.board_id) !== boardId
        || !source
        || source.content_state !== 'present'
        || source.redaction_state === 'withheld'
        || source.ingest_state === 'forgotten'
        || ordinals.has(ordinalKey)
      ) {
        runtimeError('retrieval_source_corrupt')
      }
      ordinals.add(ordinalKey)
      output.push(chunk)
    } catch (error) {
      if (error instanceof KnowledgeRetrievalError) throw error
      runtimeError('retrieval_source_corrupt')
    }
  }
  return output
}

function sourceIsRetrievable(source: KnowledgeSource): boolean {
  return source.freshness_state === 'fresh'
    && source.redaction_state !== 'withheld'
    && source.content_state === 'present'
    && source.ingest_state === 'active'
}

function ftsRowId(boardId: number, chunkId: string): number {
  const digest = createHash('sha256')
    .update('orchestra-agent-os:knowledge-retrieval-rowid:v1\0', 'utf8')
    .update(`${boardId}\0${chunkId}`, 'utf8')
    .digest('hex')
  const rowid = Number.parseInt(digest.slice(0, 13), 16) + 1
  if (!Number.isSafeInteger(rowid) || rowid < 1 || rowid > MAX_SAFE_FTS_ROWID) {
    runtimeError('retrieval_rowid_collision')
  }
  return rowid
}

function retrievalDocuments(
  db: Database.Database,
  boardId: number,
): RetrievalDocument[] {
  assertBoard(db, boardId)
  const sources = readSources(db, boardId)
  const chunks = readChunks(db, boardId, sources)
  const documents: RetrievalDocument[] = []
  const rowids = new Map<number, string>()
  for (const chunk of chunks) {
    const source = sources.get(chunk.source_id)
    if (!source) runtimeError('retrieval_source_corrupt')
    if (!sourceIsRetrievable(source)) continue
    const rowid = ftsRowId(boardId, chunk.id)
    const collision = rowids.get(rowid)
    if (collision !== undefined && collision !== chunk.id) {
      runtimeError('retrieval_rowid_collision')
    }
    rowids.set(rowid, chunk.id)
    const ftsSymbol = chunk.symbol?.qualified_name ?? ''
    const documentFingerprint = hash('document', {
      board_id: boardId,
      source,
      chunk,
      fts: {
        content: chunk.content,
        title: source.title,
        locator: source.normalized_locator,
        symbol: ftsSymbol,
      },
    })
    documents.push({
      board_id: boardId,
      fts_rowid: rowid,
      source,
      chunk,
      document_fingerprint: documentFingerprint,
      fts_content: chunk.content,
      fts_title: source.title,
      fts_locator: source.normalized_locator,
      fts_symbol: ftsSymbol,
    })
  }
  documents.sort((left, right) => {
    const sourceOrder = compareCodeUnits(left.source.id, right.source.id)
    return sourceOrder !== 0
      ? sourceOrder
      : compareCodeUnits(left.chunk.id, right.chunk.id)
  })
  return documents
}

function snapshotHash(documents: readonly RetrievalDocument[]): string {
  return hash('snapshot', documents.map((document) => ({
    board_id: document.board_id,
    fts_rowid: document.fts_rowid,
    source_id: document.source.id,
    chunk_id: document.chunk.id,
    document_fingerprint: document.document_fingerprint,
  })))
}

function readIndexedDocuments(
  db: Database.Database,
  boardId: number,
): IndexedDocumentRow[] {
  const rows = db.prepare(`SELECT board_id, fts_rowid, source_id, chunk_id,
      document_fingerprint FROM knowledge_retrieval_documents
    WHERE board_id=? ORDER BY source_id, chunk_id`)
    .all(boardId) as Array<Record<string, unknown>>
  return rows.map((row) => {
    const retained: IndexedDocumentRow = {
      board_id: rawInteger(row.board_id),
      fts_rowid: rawInteger(row.fts_rowid, MAX_SAFE_FTS_ROWID),
      source_id: rawString(row.source_id),
      chunk_id: rawString(row.chunk_id),
      document_fingerprint: rawString(row.document_fingerprint),
    }
    if (
      retained.board_id !== boardId
      || retained.fts_rowid < 1
      || !SOURCE_ID.test(retained.source_id)
      || !CHUNK_ID.test(retained.chunk_id)
      || !SHA256.test(retained.document_fingerprint)
    ) {
      runtimeError('retrieval_index_drift')
    }
    return retained
  })
}

function readIndexState(
  db: Database.Database,
  boardId: number,
): StoredIndexState | null {
  const row = db.prepare(`SELECT board_id, schema_version, snapshot_sha256,
      document_count, indexed_at FROM knowledge_retrieval_index_state
    WHERE board_id=?`).get(boardId) as Record<string, unknown> | undefined
  if (!row) return null
  const state: StoredIndexState = {
    board_id: rawInteger(row.board_id),
    schema_version: rawInteger(row.schema_version),
    snapshot_sha256: rawString(row.snapshot_sha256),
    document_count: rawInteger(row.document_count),
    indexed_at: rawString(row.indexed_at),
  }
  if (
    state.board_id !== boardId
    || state.schema_version !== RETRIEVAL_SCHEMA_VERSION
    || !SHA256.test(state.snapshot_sha256)
    || !ISO_TIMESTAMP.test(state.indexed_at)
    || new Date(state.indexed_at).toISOString() !== state.indexed_at
  ) {
    runtimeError('retrieval_index_drift')
  }
  return state
}

function readFtsRowsForBoard(
  db: Database.Database,
  boardId: number,
): FtsRow[] {
  const rows = db.prepare(`SELECT fts.rowid, fts.content, fts.title,
      fts.locator, fts.symbol
    FROM knowledge_retrieval_fts AS fts
    JOIN knowledge_retrieval_documents AS document
      ON document.fts_rowid=fts.rowid
    WHERE document.board_id=?
    ORDER BY fts.rowid`).all(boardId) as Array<Record<string, unknown>>
  return rows.map((row) => ({
    rowid: rawInteger(row.rowid, MAX_SAFE_FTS_ROWID),
    content: rawString(row.content),
    title: rawString(row.title),
    locator: rawString(row.locator),
    symbol: rawString(row.symbol),
  }))
}

function assertNoOrphanFtsRows(db: Database.Database): void {
  const orphan = db.prepare(`SELECT fts.rowid
    FROM knowledge_retrieval_fts AS fts
    LEFT JOIN knowledge_retrieval_documents AS document
      ON document.fts_rowid=fts.rowid
    WHERE document.fts_rowid IS NULL
    LIMIT 1`).get()
  if (orphan) runtimeError('retrieval_index_drift')
}

function assertDocumentsAndFts(
  db: Database.Database,
  boardId: number,
  desired: readonly RetrievalDocument[],
  indexed: readonly IndexedDocumentRow[],
): void {
  if (desired.length !== indexed.length) runtimeError('retrieval_index_drift')
  const desiredByChunk = new Map(desired.map((document) => [document.chunk.id, document]))
  const desiredByRowid = new Map(desired.map((document) => [document.fts_rowid, document]))
  if (
    desiredByChunk.size !== desired.length
    || desiredByRowid.size !== desired.length
  ) {
    runtimeError('retrieval_rowid_collision')
  }
  for (const row of indexed) {
    const document = desiredByChunk.get(row.chunk_id)
    if (
      !document
      || row.board_id !== boardId
      || row.fts_rowid !== document.fts_rowid
      || row.source_id !== document.source.id
      || row.document_fingerprint !== document.document_fingerprint
    ) {
      runtimeError('retrieval_index_drift')
    }
  }
  const ftsRows = readFtsRowsForBoard(db, boardId)
  if (ftsRows.length !== desired.length) runtimeError('retrieval_index_drift')
  for (const row of ftsRows) {
    const document = desiredByRowid.get(row.rowid)
    if (
      !document
      || row.content !== document.fts_content
      || row.title !== document.fts_title
      || row.locator !== document.fts_locator
      || row.symbol !== document.fts_symbol
    ) {
      runtimeError('retrieval_index_drift')
    }
  }
  assertNoOrphanFtsRows(db)
}

function documentsForIndexedSubset(
  desired: readonly RetrievalDocument[],
  indexed: readonly IndexedDocumentRow[],
): RetrievalDocument[] {
  const desiredByChunk = new Map(desired.map((document) => [document.chunk.id, document]))
  const subset = indexed.map((row) => {
    const document = desiredByChunk.get(row.chunk_id)
    if (
      !document
      || document.fts_rowid !== row.fts_rowid
      || document.source.id !== row.source_id
      || document.document_fingerprint !== row.document_fingerprint
    ) {
      runtimeError('retrieval_index_drift')
    }
    return document
  })
  subset.sort((left, right) => {
    const sourceOrder = compareCodeUnits(left.source.id, right.source.id)
    return sourceOrder !== 0
      ? sourceOrder
      : compareCodeUnits(left.chunk.id, right.chunk.id)
  })
  return subset
}

function assertStoredState(
  state: StoredIndexState | null,
  documents: readonly RetrievalDocument[],
): asserts state is StoredIndexState {
  if (
    !state
    || state.document_count !== documents.length
    || state.snapshot_sha256 !== snapshotHash(documents)
  ) {
    runtimeError('retrieval_index_drift')
  }
}

function insertDocument(
  db: Database.Database,
  document: RetrievalDocument,
): void {
  db.prepare(`INSERT INTO knowledge_retrieval_documents (
      board_id, fts_rowid, source_id, chunk_id, document_fingerprint
    ) VALUES (?, ?, ?, ?, ?)`).run(
    document.board_id,
    document.fts_rowid,
    document.source.id,
    document.chunk.id,
    document.document_fingerprint,
  )
  db.prepare(`INSERT INTO knowledge_retrieval_fts(
      rowid, content, title, locator, symbol
    ) VALUES (?, ?, ?, ?, ?)`).run(
    document.fts_rowid,
    document.fts_content,
    document.fts_title,
    document.fts_locator,
    document.fts_symbol,
  )
}

function putIndexState(
  db: Database.Database,
  boardId: number,
  documents: readonly RetrievalDocument[],
  indexedAt: string,
): void {
  db.prepare(`INSERT INTO knowledge_retrieval_index_state (
      board_id, schema_version, snapshot_sha256, document_count, indexed_at
    ) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(board_id) DO UPDATE SET
      schema_version=excluded.schema_version,
      snapshot_sha256=excluded.snapshot_sha256,
      document_count=excluded.document_count,
      indexed_at=excluded.indexed_at`).run(
    boardId,
    RETRIEVAL_SCHEMA_VERSION,
    snapshotHash(documents),
    documents.length,
    indexedAt,
  )
}

/**
 * Adds newly ingested eligible chunks. Existing indexed rows must still be an
 * exact subset of current source truth; removal/state transitions require the
 * explicit rebuild helper.
 */
export function synchronizeKnowledgeRetrievalIndex(
  db: Database.Database,
  requestValue: KnowledgeRetrievalSyncRequest,
): KnowledgeRetrievalSyncResult {
  return protect(() => {
    const request = validateSyncRequest(requestValue)
    assertRetrievalSchema(db)
    const synchronize = db.transaction(() => {
      const desired = retrievalDocuments(db, request.board_id)
      const indexed = readIndexedDocuments(db, request.board_id)
      const state = readIndexState(db, request.board_id)
      if (state === null && indexed.length !== 0) {
        runtimeError('retrieval_index_drift')
      }
      if (state !== null) {
        const previous = documentsForIndexedSubset(desired, indexed)
        assertStoredState(state, previous)
        assertDocumentsAndFts(db, request.board_id, previous, indexed)
      } else {
        assertNoOrphanFtsRows(db)
      }
      const indexedIds = new Set(indexed.map((row) => row.chunk_id))
      const additions = desired.filter((document) => !indexedIds.has(document.chunk.id))
      if (additions.length === 0 && state !== null) {
        assertDocumentsAndFts(db, request.board_id, desired, indexed)
        return {
          board_id: request.board_id,
          mode: 'incremental' as const,
          status: 'unchanged' as const,
          inserted_documents: 0,
          removed_documents: 0,
          document_count: desired.length,
          snapshot_sha256: state.snapshot_sha256,
          indexed_at: state.indexed_at,
        }
      }
      for (const document of additions) insertDocument(db, document)
      putIndexState(db, request.board_id, desired, request.indexed_at)
      const retained = readIndexedDocuments(db, request.board_id)
      const retainedState = readIndexState(db, request.board_id)
      assertDocumentsAndFts(db, request.board_id, desired, retained)
      assertStoredState(retainedState, desired)
      return {
        board_id: request.board_id,
        mode: 'incremental' as const,
        status: state === null ? 'created' as const : 'updated' as const,
        inserted_documents: additions.length,
        removed_documents: 0,
        document_count: desired.length,
        snapshot_sha256: retainedState.snapshot_sha256,
        indexed_at: retainedState.indexed_at,
      }
    })
    return synchronize.immediate()
  }, 'retrieval_index_drift')
}

function assertRebuildableFts(
  db: Database.Database,
  boardId: number,
  indexed: readonly IndexedDocumentRow[],
): void {
  assertNoOrphanFtsRows(db)
  const boardRowids = new Set(indexed.map((row) => row.fts_rowid))
  const otherRows = db.prepare(`SELECT fts.rowid
    FROM knowledge_retrieval_fts AS fts
    JOIN knowledge_retrieval_documents AS document
      ON document.fts_rowid=fts.rowid
    WHERE document.board_id<>?
    ORDER BY fts.rowid`).all(boardId) as Array<{ rowid: number }>
  for (const row of otherRows) {
    if (boardRowids.has(Number(row.rowid))) runtimeError('retrieval_rowid_collision')
  }
}

/**
 * Rebuilds one board deterministically from authoritative knowledge rows.
 * Corrupt source rows and unattributable/orphan FTS rows are never repaired
 * implicitly; they remain fail-closed operator errors.
 */
export function rebuildKnowledgeRetrievalIndex(
  db: Database.Database,
  requestValue: KnowledgeRetrievalSyncRequest,
): KnowledgeRetrievalSyncResult {
  return protect(() => {
    const request = validateSyncRequest(requestValue)
    assertRetrievalSchema(db)
    const rebuild = db.transaction(() => {
      const desired = retrievalDocuments(db, request.board_id)
      const indexed = readIndexedDocuments(db, request.board_id)
      assertRebuildableFts(db, request.board_id, indexed)
      for (const row of indexed) {
        db.prepare('DELETE FROM knowledge_retrieval_fts WHERE rowid=?').run(row.fts_rowid)
      }
      db.prepare('DELETE FROM knowledge_retrieval_documents WHERE board_id=?')
        .run(request.board_id)
      db.prepare('DELETE FROM knowledge_retrieval_index_state WHERE board_id=?')
        .run(request.board_id)
      for (const document of desired) insertDocument(db, document)
      putIndexState(db, request.board_id, desired, request.indexed_at)
      const retained = readIndexedDocuments(db, request.board_id)
      const retainedState = readIndexState(db, request.board_id)
      assertDocumentsAndFts(db, request.board_id, desired, retained)
      assertStoredState(retainedState, desired)
      return {
        board_id: request.board_id,
        mode: 'rebuild' as const,
        status: 'rebuilt' as const,
        inserted_documents: desired.length,
        removed_documents: indexed.length,
        document_count: desired.length,
        snapshot_sha256: retainedState.snapshot_sha256,
        indexed_at: retainedState.indexed_at,
      }
    })
    return rebuild.immediate()
  }, 'retrieval_index_drift')
}

function bindList(
  values: readonly string[],
  prefix: string,
  parameters: Record<string, string | number | null>,
): string {
  return values.map((value, index) => {
    const key = `${prefix}_${index}`
    parameters[key] = value
    return `@${key}`
  }).join(', ')
}

function allowedAccessScopes(request: KnowledgeRetrievalRequest): string[] {
  const values: unknown[] = [{ kind: 'board' }]
  if (request.access_scope.kind !== 'board') values.push(request.access_scope)
  return values.map((value) => canonicalKnowledgeJson(value)).sort(compareCodeUnits)
}

function retrievalSql(request: KnowledgeRetrievalRequest): {
  sql: string
  parameters: Record<string, string | number | null>
} {
  const parameters: Record<string, string | number | null> = {
    board_id: request.board_id,
    repository_key: request.repository_key,
    base_commit_sha: request.base_commit_sha,
    fts_query: knowledgeRetrievalFtsExpression(request.query),
    limit: request.limit,
  }
  const conditions = [
    'document.board_id=@board_id',
    "json_extract(source.provenance_json, '$.repository_key')=@repository_key",
    "json_extract(source.provenance_json, '$.base_commit_sha')=@base_commit_sha",
    `source.source_kind IN (${bindList(request.source_kinds, 'source_kind', parameters)})`,
    `source.freshness_state IN (${
      bindList(request.freshness_states, 'freshness_state', parameters)
    })`,
    `source.redaction_state IN (${
      bindList(request.redaction_states, 'redaction_state', parameters)
    })`,
    `source.content_state IN (${
      bindList(request.content_states, 'content_state', parameters)
    })`,
    `source.ingest_state IN (${
      bindList(request.ingest_states, 'ingest_state', parameters)
    })`,
    `source.access_scope_json IN (${
      bindList(allowedAccessScopes(request), 'access_scope', parameters)
    })`,
  ]
  if (request.source_revisions.length > 0) {
    conditions.push(`source.source_revision IN (${
      bindList(request.source_revisions, 'source_revision', parameters)
    })`)
  }
  if (request.paths.length > 0 || request.path_prefixes.length > 0) {
    const pathConditions: string[] = []
    if (request.paths.length > 0) {
      pathConditions.push(`source.normalized_locator IN (${
        bindList(request.paths, 'path', parameters)
      })`)
    }
    request.path_prefixes.forEach((prefix, index) => {
      const key = `path_prefix_${index}`
      parameters[key] = prefix
      pathConditions.push(`instr(source.normalized_locator, @${key})=1`)
    })
    conditions.push(`(${pathConditions.join(' OR ')})`)
  }
  if (request.symbols.length > 0) {
    conditions.push(`json_extract(chunk.symbol_json, '$.qualified_name') IN (${
      bindList(request.symbols, 'symbol', parameters)
    })`)
  }
  return {
    sql: `SELECT document.fts_rowid,
        CAST(max(
          0,
          round(-bm25(knowledge_retrieval_fts, 10.0, 2.0, 1.0, 3.0) * 1000000)
        ) AS INTEGER) AS relevance_micros
      FROM knowledge_retrieval_fts
      JOIN knowledge_retrieval_documents AS document
        ON document.fts_rowid=knowledge_retrieval_fts.rowid
      JOIN knowledge_sources AS source
        ON source.board_id=document.board_id
        AND source.id=document.source_id
      JOIN knowledge_chunks AS chunk
        ON chunk.board_id=document.board_id
        AND chunk.source_id=document.source_id
        AND chunk.id=document.chunk_id
      WHERE knowledge_retrieval_fts MATCH @fts_query
        AND ${conditions.join('\n        AND ')}
      ORDER BY relevance_micros DESC, document.source_id, document.chunk_id
      LIMIT @limit`,
    parameters,
  }
}

function citationFor(document: RetrievalDocument): KnowledgeRetrievalCitation {
  const source = document.source
  const chunk = document.chunk
  return {
    board_id: document.board_id,
    source_id: source.id,
    chunk_id: chunk.id,
    source_kind: source.source_kind,
    trust_class: source.trust_class,
    title: source.title,
    locator: source.locator,
    normalized_locator: source.normalized_locator,
    repository_key: source.provenance.repository_key,
    base_commit_sha: source.provenance.base_commit_sha,
    source_revision: source.source_revision,
    source_content_sha256: source.content_sha256,
    freshness_policy: source.freshness_policy,
    freshness_state: source.freshness_state,
    redaction_state: source.redaction_state,
    content_state: source.content_state,
    ingest_state: source.ingest_state,
    access_scope: source.access_scope,
    targets: source.targets,
    ordinal: chunk.ordinal,
    chunk_content_sha256: chunk.content_sha256,
    character_count: chunk.character_count,
    byte_count: chunk.byte_count,
    estimated_tokens: chunk.estimated_tokens,
    source_range: chunk.source_range,
    symbol: chunk.symbol,
    provenance: source.provenance,
  }
}

/**
 * Executes a bounded local FTS5 query only after a full board snapshot
 * attestation. Source content is returned verbatim but explicitly labeled as
 * untrusted data; it is never interpreted as FTS or instruction syntax.
 */
export function retrieveKnowledge(
  db: Database.Database,
  requestValue: KnowledgeRetrievalRequest,
): KnowledgeRetrievalResult {
  return protect(() => {
    const request = validateKnowledgeRetrievalRequest(requestValue)
    assertRetrievalSchema(db)
    const retrieve = db.transaction(() => {
      assertBoard(db, request.board_id)
      assertTargetsAuthority(
        db,
        request.board_id,
        request.targets,
        'retrieval_scope_invalid',
      )
      const desired = retrievalDocuments(db, request.board_id)
      const indexed = readIndexedDocuments(db, request.board_id)
      const state = readIndexState(db, request.board_id)
      assertDocumentsAndFts(db, request.board_id, desired, indexed)
      assertStoredState(state, desired)
      const documentByRowid = new Map(
        desired.map((document) => [document.fts_rowid, document]),
      )
      let matches: Array<Record<string, unknown>>
      try {
        const statement = retrievalSql(request)
        matches = db.prepare(statement.sql).all(statement.parameters) as Array<
          Record<string, unknown>
        >
      } catch {
        runtimeError('retrieval_query_failed')
      }
      const results = matches.map((row, index) => {
        const rowid = rawInteger(row.fts_rowid, MAX_SAFE_FTS_ROWID)
        const document = documentByRowid.get(rowid)
        const relevance = rawInteger(row.relevance_micros, 1_000_000_000_000)
        if (
          !document
          || !sourceVisibleToKnowledgeRetrievalRequest(
            document.source.access_scope,
            document.source.targets,
            request,
          )
        ) {
          runtimeError('retrieval_index_drift')
        }
        return {
          rank: index + 1,
          relevance_micros: relevance,
          content: document.chunk.content,
          content_trust: 'untrusted_data' as const,
          citation: citationFor(document),
        }
      })
      const result: KnowledgeRetrievalResult = {
        version: KNOWLEDGE_RETRIEVAL_CONTRACT_VERSION,
        request_sha256: knowledgeRetrievalRequestHash(request),
        normalized_query: request.query,
        index_snapshot_sha256: state.snapshot_sha256,
        results,
      }
      return validateKnowledgeRetrievalResult(result, request)
    })
    return retrieve.immediate()
  }, 'retrieval_query_failed')
}
