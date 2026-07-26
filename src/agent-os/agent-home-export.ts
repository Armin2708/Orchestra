import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import { AgentProfileService } from './agent-profiles.js'
import { ArtifactStore, type Artifact } from './artifact-store.js'
import {
  ConversationService,
  type AgentConversation,
  type AgentSessionRecord,
  type ConversationEvent,
} from './conversations.js'
import { ConflictError, ValidationError } from './errors.js'
import { EventStore } from './event-store.js'
import { AgentHomeLinkService, type AgentHomeLinks } from './agent-home-links.js'
import { AgentHomeSearchService } from './agent-home-search.js'
import {
  actorIdentity,
  boundedString,
  canonicalHash,
  commandReplay,
  stableJson,
  type ActorIdentity,
} from './agent-home-support.js'
import { timestamp } from './json.js'
import { redactSensitiveText, redactStructuredValue } from './structured-redaction.js'

export type AgentHomeExportFormat = 'human' | 'json'

export interface AgentHomeTranscriptExport {
  schema_version: 1
  exported_at: string
  format: 'agent-home-transcript'
  redaction_policy: {
    version: 'agent-home-v1'
    raw_artifact_content_included: false
    redactions_applied: number
  }
  profile: ReturnType<AgentProfileService['require']>
  conversation: AgentConversation
  sessions: AgentSessionRecord[]
  events: ExportedConversationEvent[]
  provenance: {
    board_id: number
    profile_id: string
    conversation_id: string
    session_ids: string[]
    event_ids: string[]
    source_content_hashes: string[]
  }
  links: AgentHomeLinks
}

export interface ExportedConversationEvent
  extends Omit<ConversationEvent, 'projected_text' | 'metadata'> {
  projected_text: string | null
  metadata: Record<string, unknown>
  export_redacted: boolean
  links: AgentHomeLinks
}

export interface TranscriptArtifactResult {
  artifact: Artifact
  export: {
    format: AgentHomeExportFormat
    content_hash: string
    event_count: number
    redactions_applied: number
    replayed: boolean
  }
  links: AgentHomeLinks
}

export class AgentHomeTranscriptExporter {
  private readonly profiles: AgentProfileService
  private readonly conversations: ConversationService
  private readonly search: AgentHomeSearchService
  private readonly artifacts: ArtifactStore
  private readonly events: EventStore
  private readonly links: AgentHomeLinkService

  constructor(private readonly db: Database.Database) {
    this.profiles = new AgentProfileService(db)
    this.conversations = new ConversationService(db)
    this.search = new AgentHomeSearchService(db)
    this.artifacts = new ArtifactStore(db)
    this.events = new EventStore(db)
    this.links = new AgentHomeLinkService(db)
  }

  document(conversationId: string, sessionId?: string): AgentHomeTranscriptExport {
    const conversation = this.conversations.requireConversation(conversationId)
    const profile = this.profiles.require(conversation.profile_id)
    const sessions = sessionId
      ? [this.requireConversationSession(conversation.id, sessionId)]
      : this.conversations.listSessions(profile.id)
        .filter((session) => session.conversation_id === conversation.id)
    const events = this.allEvents(conversation.id, sessionId)
    let redactions = 0
    const redactedProfile = redactValue(profile)
    const redactedConversation = redactValue(conversation)
    const redactedSessions = sessions.map((session) => redactValue(session))
    redactions += redactedProfile.redactions + redactedConversation.redactions
      + redactedSessions.reduce((total, result) => total + result.redactions, 0)
    const safeEvents = events.map((event): ExportedConversationEvent => {
      const text = redactText(event.redaction_state === 'withheld'
        ? '[WITHHELD BY RETENTION POLICY]'
        : event.projected_text)
      const metadata = redactValue(event.metadata)
      redactions += text.redactions + metadata.redactions
        + (event.redaction_state === 'withheld' ? 1 : 0)
      const wasRedacted = text.redactions > 0 || metadata.redactions > 0
        || event.redaction_state !== 'none'
      return {
        ...event,
        projected_text: text.value,
        metadata: metadata.value as Record<string, unknown>,
        export_redacted: wasRedacted,
        links: this.links.forEvent(event),
      }
    })
    const links = sessionId
      ? this.links.forSession(sessionId)
      : this.links.forConversation(conversation.id)
    return {
      schema_version: 1,
      exported_at: timestamp(),
      format: 'agent-home-transcript',
      redaction_policy: {
        version: 'agent-home-v1',
        raw_artifact_content_included: false,
        redactions_applied: redactions,
      },
      profile: redactedProfile.value as AgentHomeTranscriptExport['profile'],
      conversation: redactedConversation.value as AgentConversation,
      sessions: redactedSessions.map((result) => result.value as AgentSessionRecord),
      events: safeEvents,
      provenance: {
        board_id: profile.board_id,
        profile_id: profile.id,
        conversation_id: conversation.id,
        session_ids: sessions.map((session) => session.id),
        event_ids: safeEvents.map((event) => event.id),
        source_content_hashes: safeEvents.map((event) => event.content_hash),
      },
      links,
    }
  }

  renderHuman(document: AgentHomeTranscriptExport): string {
    const lines = [
      `# Agent Home transcript — ${document.profile.name}`,
      '',
      `Profile: ${document.profile.id}`,
      `Conversation: ${document.conversation.id} (${document.conversation.title})`,
      `Sessions: ${document.provenance.session_ids.join(', ') || 'none'}`,
      `Exported: ${document.exported_at}`,
      `Redaction policy: ${document.redaction_policy.version}`,
      `Redactions applied: ${document.redaction_policy.redactions_applied}`,
      `Deep link: ${document.links.href}`,
      '',
    ]
    for (const event of document.events) {
      const actor = `${event.actor_type}${event.actor_id ? `:${event.actor_id}` : ''}`
      const provider = event.provider ? ` provider=${event.provider}` : ''
      const tool = textField(event.metadata.tool ?? event.metadata.tool_name ?? event.metadata.name)
      const status = textField(event.metadata.status ?? event.metadata.state)
      lines.push(
        `## ${event.sequence} · ${event.created_at} · ${actor} · ${event.kind}${provider}`,
        `event=${event.id} session=${event.session_id ?? 'none'} hash=${event.content_hash}`,
        ...(tool ? [`tool=${tool}`] : []),
        ...(status ? [`status=${status}`] : []),
        '',
        event.projected_text ?? '[no projected text]',
        '',
      )
    }
    return `${lines.join('\n').trimEnd()}\n`
  }

  content(document: AgentHomeTranscriptExport, format: AgentHomeExportFormat): string {
    return format === 'human'
      ? this.renderHuman(document)
      : `${JSON.stringify(document, null, 2)}\n`
  }

  createArtifact(input: {
    conversationId: string
    sessionId?: string
    format: AgentHomeExportFormat
    actor: ActorIdentity
    idempotencyKey: string
    correlationId?: string | null
  }): TranscriptArtifactResult {
    if (!['human', 'json'].includes(input.format)) {
      throw new ValidationError('format must be human or json')
    }
    const actor = actorIdentity(input.actor)
    const idempotencyKey = boundedString(input.idempotencyKey, 'idempotency key', 200)
    const conversation = this.conversations.requireConversation(input.conversationId)
    const profile = this.profiles.require(conversation.profile_id)
    if (input.sessionId) this.requireConversationSession(conversation.id, input.sessionId)
    const requestFingerprint = canonicalHash({
      command: 'agent_home.transcript_export',
      conversationId: conversation.id,
      sessionId: input.sessionId ?? null,
      format: input.format,
    })
    const create = this.db.transaction(() => {
      const replay = commandReplay(this.db, {
        boardId: profile.board_id,
        idempotencyKey,
        kind: 'agent_home.transcript_exported',
        requestFingerprint,
      })
      if (replay) {
        if (typeof replay.artifact_id !== 'string') {
          throw new ConflictError('transcript export replay does not reference an artifact')
        }
        const artifact = this.artifacts.get(replay.artifact_id)
        if (!artifact) throw new ConflictError('transcript export artifact is missing')
        return this.artifactResult(artifact, input.format, true)
      }

      const document = this.document(conversation.id, input.sessionId)
      const content = this.content(document, input.format)
      const contentHash = createHash('sha256').update(content).digest('hex')
      const session = input.sessionId
        ? this.conversations.requireSession(input.sessionId)
        : document.sessions.at(0)
      const card = session
        ? this.db.prepare('SELECT card_id FROM workspaces WHERE id=?').get(session.workspace_id) as
          { card_id: number | null } | undefined
        : undefined
      const artifact = this.artifacts.create({
        boardId: profile.board_id,
        workspaceId: session?.workspace_id ?? null,
        cardId: card?.card_id ?? null,
        kind: 'agent_home_transcript',
        name: `${safeName(profile.name)}-${conversation.id}.${input.format === 'human' ? 'md' : 'json'}`,
        mimeType: input.format === 'human'
          ? 'text/markdown; charset=utf-8'
          : 'application/json; charset=utf-8',
        content,
        metadata: {
          schema_version: 1,
          profile_id: profile.id,
          conversation_id: conversation.id,
          session_id: input.sessionId ?? null,
          format: input.format,
          content_hash: contentHash,
          event_count: document.events.length,
          redactions_applied: document.redaction_policy.redactions_applied,
          raw_artifact_content_included: false,
        },
      })
      this.events.append({
        boardId: profile.board_id,
        workspaceId: session?.workspace_id ?? null,
        cardId: card?.card_id ?? null,
        sessionId: input.sessionId ?? null,
        correlationId: input.correlationId ?? idempotencyKey,
        idempotencyKey,
        kind: 'agent_home.transcript_exported',
        source: 'agent-home',
        payload: {
          artifact_id: artifact.id,
          profile_id: profile.id,
          conversation_id: conversation.id,
          session_id: input.sessionId ?? null,
          format: input.format,
          content_hash: contentHash,
          request_fingerprint: requestFingerprint,
          actor,
        },
      })
      return this.artifactResult(artifact, input.format, false)
    })
    return create.immediate()
  }

  private allEvents(conversationId: string, sessionId?: string): ConversationEvent[] {
    const events: ConversationEvent[] = []
    let after = 0
    do {
      const page = this.search.search(conversationId, {
        after,
        limit: 500,
        sessionId,
        includeArchived: true,
      })
      events.push(...page.events.map(({ links: _links, ...event }) => event))
      if (!page.has_more || page.next_cursor === null) break
      after = page.next_cursor
    } while (true)
    return events
  }

  private requireConversationSession(
    conversationId: string,
    sessionId: string,
  ): AgentSessionRecord {
    const session = this.conversations.requireSession(sessionId)
    if (session.conversation_id !== conversationId) {
      throw new ValidationError('session does not belong to this conversation')
    }
    return session
  }

  private artifactResult(
    artifact: Artifact,
    format: AgentHomeExportFormat,
    replayed: boolean,
  ): TranscriptArtifactResult {
    return {
      artifact,
      export: {
        format,
        content_hash: String(artifact.metadata.content_hash ?? ''),
        event_count: Number(artifact.metadata.event_count ?? 0),
        redactions_applied: Number(artifact.metadata.redactions_applied ?? 0),
        replayed,
      },
      links: typeof artifact.metadata.session_id === 'string'
        ? this.links.forSession(artifact.metadata.session_id)
        : this.links.forConversation(String(artifact.metadata.conversation_id)),
    }
  }
}

function redactValue(value: unknown, key = ''): { value: unknown; redactions: number } {
  const result = key
    ? redactStructuredValue({ [key]: value })
    : redactStructuredValue(value)
  const safeValue = key
    ? (result.value as Record<string, unknown>)[key]
    : result.value
  return {
    value: safeValue,
    redactions: countRedactionMarkers(safeValue),
  }
}

function redactText(value: string | null): { value: string | null; redactions: number } {
  const result = redactSensitiveText(value)
  return {
    value: result.value,
    redactions: countRedactionMarkers(result.value),
  }
}

function countRedactionMarkers(value: unknown): number {
  if (typeof value === 'string') {
    return value.match(/\[REDACTED\]/g)?.length ?? 0
  }
  if (Array.isArray(value)) {
    return value.reduce((total, item) => total + countRedactionMarkers(item), 0)
  }
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>)
      .reduce<number>((total, item) => total + countRedactionMarkers(item), 0)
  }
  return 0
}

function safeName(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
    || 'agent'
}

function textField(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

export const agentHomeExportInternals = {
  redactText,
  redactValue,
  fingerprint: (value: unknown) => stableJson(value),
}
