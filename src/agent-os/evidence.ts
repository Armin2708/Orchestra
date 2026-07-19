import type Database from 'better-sqlite3'
import { Artifact, ArtifactStore } from './artifact-store.js'
import { NotFoundError } from './errors.js'
import { EventStore, OsEvent } from './event-store.js'
import { parseJson, timestamp } from './json.js'
import { TaskContract, TaskContractService } from './task-contracts.js'
import { Workspace, WorkspaceStore } from './workspace-store.js'

export interface EvidenceBundle {
  card: { id: number; board_id: number; title: string; description: string; column: string }
  contract: TaskContract
  workspace: Workspace | null
  generated_at: string
  diff: { artifact_id: string; name: string; content: string | null; path: string | null } | null
  diffstat: { artifact_id: string; content: string | null } | null
  changed_files: string[]
  verification: { artifacts: Artifact[]; events: OsEvent[] }
  process_exits: Array<{ id: string; name: string; command: string; status: string; exit_code: number | null; ended_at: string | null }>
  reviews: Array<{ id: number; decision: string; note: string | null; decided_at: string }>
  shipped: Array<{ source: string; created_at: string; detail: unknown }>
  claims: Array<{ source: string; created_at: string; claim: unknown }>
  artifacts: Artifact[]
  gaps: string[]
}

export class EvidenceService {
  private readonly artifacts: ArtifactStore
  private readonly events: EventStore
  private readonly contracts: TaskContractService
  private readonly workspaces: WorkspaceStore

  constructor(private readonly db: Database.Database) {
    this.artifacts = new ArtifactStore(db)
    this.events = new EventStore(db)
    this.contracts = new TaskContractService(db)
    this.workspaces = new WorkspaceStore(db)
  }

  assemble(cardId: number): EvidenceBundle {
    const card = this.db.prepare(`SELECT id, board_id, title, description, column_name FROM cards WHERE id=?`).get(cardId) as any
    if (!card) throw new NotFoundError('card not found')
    const contract = this.contracts.getOrCreate(cardId)
    const workspace = contract.workspace_id ? this.workspaces.get(contract.workspace_id) :
      this.workspaces.listBoard(card.board_id).find((item) => item.card_id === cardId) ?? null
    const artifacts = this.artifacts.list({ boardId: card.board_id, cardId, limit: 200 })
      .filter((artifact) => artifact.kind !== 'evidence_bundle')
    const diffArtifact = artifacts.find((artifact) => artifact.kind === 'diff' || artifact.kind === 'patch') ?? null
    const diffstatArtifact = artifacts.find((artifact) => artifact.kind === 'diffstat') ?? null
    const events = this.events.listBoard(card.board_id, { cardId, limit: 500 })
    const verificationArtifacts = artifacts.filter((artifact) => ['verification', 'test_report', 'review_report'].includes(artifact.kind))
    const verificationEvents = events.filter((event) => /verification|test/.test(event.kind))
    const processExits = workspace ? this.db.prepare(`SELECT id, name, command, status, exit_code, ended_at
      FROM processes WHERE workspace_id=? AND status IN ('exited','failed','stopped','lost') ORDER BY ended_at DESC`).all(workspace.id) as any[] : []
    const reviews = this.db.prepare(`SELECT id, decision, note, decided_at FROM review_decisions
      WHERE card_id=? ORDER BY decided_at, id`).all(cardId) as EvidenceBundle['reviews']
    const legacyShipped = (this.db.prepare(`SELECT created_at, payload FROM card_events WHERE card_id=? AND type='shipped'
      ORDER BY created_at, id`).all(cardId) as Array<{ created_at: string; payload: string }>).map((item) => ({
        source: 'card_events', created_at: item.created_at, detail: parseJson(item.payload, {}),
      }))
    const shipped = [
      ...legacyShipped,
      ...events.filter((event) => /shipped|ship\.completed/.test(event.kind))
        .map((event) => ({ source: event.source, created_at: event.created_at, detail: event.payload })),
    ]
    const claims = events.filter((event) => event.kind === 'claim' || event.kind.endsWith('.claim') ||
      (!!event.payload && typeof event.payload === 'object' && 'claim' in event.payload))
      .map((event) => ({ source: event.source, created_at: event.created_at,
        claim: event.payload && typeof event.payload === 'object' && 'claim' in event.payload ? event.payload.claim : event.payload }))
    const changedFiles = collectChangedFiles(artifacts, diffArtifact)
    const gaps: string[] = []
    if (!diffArtifact) gaps.push('No diff or patch artifact has been recorded.')
    if (!verificationArtifacts.length && !verificationEvents.length) gaps.push('No verification evidence has been recorded.')
    if (!reviews.length) gaps.push('No human or independent review decision has been recorded.')
    if (card.column_name === 'done' && !shipped.length) gaps.push('The card is done but has no shipped-commit evidence.')
    return {
      card: { id: card.id, board_id: card.board_id, title: card.title, description: card.description, column: card.column_name },
      contract, workspace, generated_at: timestamp(),
      diff: diffArtifact ? { artifact_id: diffArtifact.id, name: diffArtifact.name, content: diffArtifact.content, path: diffArtifact.path } : null,
      diffstat: diffstatArtifact ? { artifact_id: diffstatArtifact.id, content: diffstatArtifact.content } : null,
      changed_files: changedFiles,
      verification: { artifacts: verificationArtifacts, events: verificationEvents },
      process_exits: processExits.map((row) => ({ ...row, exit_code: row.exit_code == null ? null : Number(row.exit_code) })),
      reviews, shipped, claims, artifacts, gaps,
    }
  }

  persist(cardId: number): { evidence: EvidenceBundle; artifact: Artifact } {
    const evidence = this.assemble(cardId)
    const artifact = this.artifacts.create({ boardId: evidence.card.board_id, workspaceId: evidence.workspace?.id,
      cardId, kind: 'evidence_bundle', name: `evidence-card-${cardId}-${evidence.generated_at}.json`,
      mimeType: 'application/json', content: JSON.stringify(evidence, null, 2),
      metadata: { generated_at: evidence.generated_at, gaps: evidence.gaps, claim_count: evidence.claims.length } })
    this.events.append({ boardId: evidence.card.board_id, workspaceId: evidence.workspace?.id, cardId,
      kind: 'evidence.generated', source: 'evidence', payload: { artifact_id: artifact.id, gaps: evidence.gaps } })
    return { evidence, artifact }
  }
}

function collectChangedFiles(artifacts: Artifact[], diff: Artifact | null): string[] {
  const files = new Set<string>()
  for (const artifact of artifacts) {
    const changed = artifact.metadata.changed_files
    if (Array.isArray(changed)) for (const file of changed) if (typeof file === 'string') files.add(file)
  }
  if (diff?.content) {
    for (const line of diff.content.split('\n')) {
      const match = /^(?:\+\+\+ b\/|--- a\/|diff --git a\/[^ ]+ b\/)(.+)$/.exec(line)
      if (!match) continue
      const value = line.startsWith('diff --git') ? line.slice(line.lastIndexOf(' b/') + 3) : match[1]
      if (value && value !== '/dev/null') files.add(value)
    }
  }
  return [...files].sort()
}
