import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { openDb } from '../src/db.js'
import { AgentProfileService } from '../src/agent-os/agent-profiles.js'
import { ConversationService } from '../src/agent-os/conversations.js'
import { applyAgentOsMigrations } from '../src/agent-os/migrations.js'

const actor = { type: 'operator', id: 'test-operator' }
const tempDirectories: string[] = []

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe('durable Agent Home domain', () => {
  it('creates, replays, updates, and archives durable profiles and conversations', () => {
    const db = openDb(':memory:')
    const { boardId } = seedScope(db)
    const profiles = new AgentProfileService(db)
    const conversations = new ConversationService(db)

    const created = profiles.create({
      boardId,
      name: 'Builder',
      role: 'implementation',
      defaultProvider: 'codex',
      defaultModel: 'gpt-codex',
      defaultEffort: 'high',
      defaultAccessProfile: 'workspace_write',
      capabilities: ['code', 'review', 'code'],
      actor,
      idempotencyKey: 'profile:create:builder',
    })
    const replay = profiles.create({
      boardId,
      name: 'Builder',
      role: 'implementation',
      defaultProvider: 'codex',
      defaultModel: 'gpt-codex',
      defaultEffort: 'high',
      defaultAccessProfile: 'workspace_write',
      capabilities: ['code', 'review', 'code'],
      actor,
      idempotencyKey: 'profile:create:builder',
    })
    expect(replay.id).toBe(created.id)
    expect(created).toMatchObject({
      name: 'Builder',
      role: 'implementation',
      default_provider: 'codex',
      capabilities: ['code', 'review'],
      status: 'active',
    })
    expect(() => profiles.create({
      boardId,
      name: 'Different',
      actor,
      idempotencyKey: 'profile:create:builder',
    })).toThrow(/idempotency key/)
    expect((db.prepare('SELECT COUNT(*) AS count FROM agent_profiles').get() as any).count).toBe(1)

    const defaults = conversations.listConversations(created.id)
    expect(defaults).toEqual([
      expect.objectContaining({
        profile_id: created.id,
        title: 'Builder conversation',
        is_default: true,
      }),
    ])
    const updated = profiles.update(created.id, {
      name: 'Senior Builder',
      role: 'delivery',
      capabilities: ['code', 'verification'],
      actor,
      idempotencyKey: 'profile:update:builder',
    })
    expect(updated).toMatchObject({
      name: 'Senior Builder',
      role: 'delivery',
      capabilities: ['code', 'verification'],
    })
    expect(profiles.update(created.id, {
      name: 'Senior Builder',
      role: 'delivery',
      capabilities: ['code', 'verification'],
      actor,
      idempotencyKey: 'profile:update:builder',
    }).id).toBe(created.id)
    expect(conversations.listConversations(created.id)[0].title)
      .toBe('Senior Builder conversation')

    const side = conversations.createConversation(created.id, {
      title: 'Review thread',
      actor,
      idempotencyKey: 'conversation:create:review',
    })
    expect(conversations.createConversation(created.id, {
      title: 'Review thread',
      actor,
      idempotencyKey: 'conversation:create:review',
    }).id).toBe(side.id)
    expect(conversations.updateConversation(side.id, {
      title: 'Review and verification',
      actor,
      idempotencyKey: 'conversation:update:review',
    }).title).toBe('Review and verification')
    expect(conversations.archiveConversation(side.id, {
      actor,
      idempotencyKey: 'conversation:archive:review',
    }).status).toBe('archived')
    expect(() => conversations.archiveConversation(defaults[0].id, {
      actor,
      idempotencyKey: 'conversation:archive:default',
    })).toThrow(/default conversation/)

    const archived = profiles.archive(created.id, {
      actor,
      idempotencyKey: 'profile:archive:builder',
    })
    expect(archived.status).toBe('archived')
    expect(conversations.listConversations(created.id, true).every(
      (conversation) => conversation.status === 'archived',
    )).toBe(true)
    expect(profiles.update(created.id, {
      name: 'Senior Builder',
      role: 'delivery',
      capabilities: ['code', 'verification'],
      actor,
      idempotencyKey: 'profile:update:builder',
    })).toMatchObject({ id: created.id, status: 'archived' })
    expect(conversations.createConversation(created.id, {
      title: 'Review thread',
      actor,
      idempotencyKey: 'conversation:create:review',
    })).toMatchObject({ id: side.id, status: 'archived' })
    expect(conversations.updateConversation(side.id, {
      title: 'Review and verification',
      actor,
      idempotencyKey: 'conversation:update:review',
    })).toMatchObject({ id: side.id, status: 'archived' })
    db.close()
  })

  it('links scoped sessions and atomically stores exact ordered event replay with retained conflicts', () => {
    const db = openDb(':memory:')
    const {
      boardId,
      otherBoardId,
      workspaceId,
      otherWorkspaceId,
      sessionId,
      otherSessionId,
      jobId,
      artifactId,
      otherArtifactId,
    } = seedScope(db)
    const profiles = new AgentProfileService(db)
    const conversations = new ConversationService(db)
    const profile = profiles.create({
      boardId,
      name: 'Scoped builder',
      actor,
      idempotencyKey: 'profile:create:scoped',
    })
    const conversation = conversations.listConversations(profile.id)[0]

    const linked = conversations.linkSession(sessionId, {
      profileId: profile.id,
      conversationId: conversation.id,
      jobId,
      mode: 'managed',
      driverId: 'codex-app-server',
      effort: 'high',
      accessProfile: 'workspace_write',
      providerThreadId: 'thread-1',
      recoveryState: 'attachable',
      recovery: { source: 'test' },
      historyState: 'complete',
      actor,
      idempotencyKey: 'session:link:primary',
    })
    expect(linked).toMatchObject({
      id: sessionId,
      workspace_id: workspaceId,
      profile_id: profile.id,
      conversation_id: conversation.id,
      job_id: jobId,
      mode: 'managed',
      provider_thread_id: 'thread-1',
      recovery_state: 'attachable',
      recovery: { source: 'test' },
      history_state: 'complete',
    })
    expect(conversations.linkSession(sessionId, {
      profileId: profile.id,
      conversationId: conversation.id,
      jobId,
      mode: 'managed',
      driverId: 'codex-app-server',
      effort: 'high',
      accessProfile: 'workspace_write',
      providerThreadId: 'thread-1',
      recoveryState: 'attachable',
      recovery: { source: 'test' },
      historyState: 'complete',
      actor,
      idempotencyKey: 'session:link:primary',
    }).id).toBe(sessionId)

    expect(() => conversations.linkSession(otherSessionId, {
      profileId: profile.id,
      conversationId: conversation.id,
      mode: 'ambient',
      actor,
      idempotencyKey: 'session:link:cross-board',
    })).toThrow(/board scope/)
    expect(() => conversations.linkSession(sessionId, {
      profileId: profile.id,
      conversationId: conversation.id,
      jobId: 'job-other',
      mode: 'managed',
      actor,
      idempotencyKey: 'session:link:cross-job',
    })).toThrow(/job identities are inconsistent/)

    const first = conversations.appendEvent(sessionId, {
      idempotencyKey: 'event:append:first',
      dedupeKey: 'provider:event:1',
      kind: 'assistant',
      providerEventId: 'event-1',
      providerThreadId: 'thread-1',
      providerCursor: 'cursor-1',
      projectedText: 'First answer',
      metadata: { usage: { output: 12 } },
      rawArtifactId: artifactId,
      actor: { type: 'agent', id: 'codex' },
      correlationId: 'turn-1',
    })
    const replay = conversations.appendEvent(sessionId, {
      idempotencyKey: 'event:append:first',
      dedupeKey: 'provider:event:1',
      kind: 'assistant',
      providerEventId: 'event-1',
      providerThreadId: 'thread-1',
      providerCursor: 'cursor-1',
      projectedText: 'First answer',
      metadata: { usage: { output: 12 } },
      rawArtifactId: artifactId,
      actor: { type: 'agent', id: 'codex' },
      correlationId: 'turn-1',
    })
    expect(first).toMatchObject({ replayed: false, event: { sequence: 1 } })
    expect(replay).toMatchObject({ replayed: true, event: { id: first.event.id, sequence: 1 } })

    const replayWithNewCommandKey = conversations.appendEvent(sessionId, {
      idempotencyKey: 'event:append:first:replay',
      dedupeKey: 'provider:event:1',
      kind: 'assistant',
      providerEventId: 'event-1',
      providerThreadId: 'thread-1',
      providerCursor: 'cursor-1',
      projectedText: 'First answer',
      metadata: { usage: { output: 12 } },
      rawArtifactId: artifactId,
      actor: { type: 'agent', id: 'codex' },
      correlationId: 'turn-1',
    })
    expect(replayWithNewCommandKey).toMatchObject({
      replayed: true,
      event: { id: first.event.id, sequence: 1 },
    })
    expect((db.prepare(
      "SELECT kind FROM os_events WHERE idempotency_key='event:append:first:replay'",
    ).get() as any).kind).toBe('conversation.event_replayed')
    expect(() => conversations.appendEvent(sessionId, {
      idempotencyKey: 'event:append:first:replay',
      dedupeKey: 'provider:event:reused-command-key',
      kind: 'status',
      projectedText: 'This command key must stay bound to the replay',
      actor: { type: 'agent', id: 'codex' },
    })).toThrow(/idempotency key/)

    const second = conversations.appendEvent(sessionId, {
      idempotencyKey: 'event:append:second',
      dedupeKey: 'provider:event:2',
      kind: 'tool',
      projectedText: 'npm test',
      metadata: { tool: 'terminal' },
      actor: { type: 'agent', id: 'codex' },
    })
    expect(second.event.sequence).toBe(2)
    expect(conversations.listEvents(conversation.id).map((event) => event.sequence))
      .toEqual([1, 2])
    expect(conversations.listEvents(conversation.id, { afterSequence: 1 }))
      .toEqual([expect.objectContaining({ id: second.event.id, sequence: 2 })])
    expect(conversations.listSessionEvents(sessionId, { kinds: ['assistant'] }))
      .toEqual([expect.objectContaining({ id: first.event.id })])

    expect(() => conversations.appendEvent(sessionId, {
      idempotencyKey: 'event:append:conflict',
      dedupeKey: 'provider:event:1',
      kind: 'assistant',
      projectedText: 'Mutated answer',
      metadata: { usage: { output: 99 } },
      actor: { type: 'agent', id: 'codex' },
    })).toThrow(/conflict/)
    expect(conversations.requireEvent(first.event.id).projected_text).toBe('First answer')
    expect((db.prepare('SELECT COUNT(*) AS count FROM conversation_event_conflicts').get() as any).count)
      .toBe(1)
    expect((db.prepare(
      "SELECT COUNT(*) AS count FROM os_events WHERE kind='conversation.event_conflict'",
    ).get() as any).count).toBe(1)
    expect(() => conversations.appendEvent(sessionId, {
      idempotencyKey: 'event:append:first',
      dedupeKey: 'provider:event:1',
      kind: 'assistant',
      projectedText: 'Corrupted retry using the original command key',
      actor: { type: 'agent', id: 'codex' },
    })).toThrow(/conflict/)
    expect((db.prepare('SELECT COUNT(*) AS count FROM conversation_event_conflicts').get() as any).count)
      .toBe(2)

    expect(() => conversations.appendEvent(sessionId, {
      idempotencyKey: 'event:append:artifact-cross-board',
      dedupeKey: 'provider:event:3',
      kind: 'tool_result',
      rawArtifactId: otherArtifactId,
      actor: { type: 'agent', id: 'codex' },
    })).toThrow(/different board or workspace/)
    expect(() => conversations.appendEvent(sessionId, {
      idempotencyKey: 'event:append:second',
      dedupeKey: 'provider:event:different',
      kind: 'status',
      projectedText: 'different',
      actor: { type: 'agent', id: 'codex' },
    })).toThrow(/idempotency key/)
    expect(conversations.listEvents(conversation.id)).toHaveLength(2)

    const home = conversations.home(profile.id)
    expect(home).toMatchObject({
      profile: { id: profile.id },
      active_session: { id: sessionId },
      active_scope: {
        workspace: { id: workspaceId },
        job: { id: jobId },
      },
    })
    expect(() => profiles.archive(profile.id, {
      actor,
      idempotencyKey: 'profile:archive:active',
    })).toThrow(/active session/)
    db.prepare("UPDATE agent_sessions SET status='stopped' WHERE id=?").run(sessionId)
    expect(profiles.archive(profile.id, {
      actor,
      idempotencyKey: 'profile:archive:stopped',
    }).status).toBe('archived')
    expect(conversations.linkSession(sessionId, {
      profileId: profile.id,
      conversationId: conversation.id,
      jobId,
      mode: 'managed',
      driverId: 'codex-app-server',
      effort: 'high',
      accessProfile: 'workspace_write',
      providerThreadId: 'thread-1',
      recoveryState: 'attachable',
      recovery: { source: 'test' },
      historyState: 'complete',
      actor,
      idempotencyKey: 'session:link:primary',
    }).id).toBe(sessionId)
    expect(conversations.appendEvent(sessionId, {
      idempotencyKey: 'event:append:first',
      dedupeKey: 'provider:event:1',
      kind: 'assistant',
      providerEventId: 'event-1',
      providerThreadId: 'thread-1',
      providerCursor: 'cursor-1',
      projectedText: 'First answer',
      metadata: { usage: { output: 12 } },
      rawArtifactId: artifactId,
      actor: { type: 'agent', id: 'codex' },
      correlationId: 'turn-1',
    })).toMatchObject({ replayed: true, event: { id: first.event.id } })

    expect(otherBoardId).not.toBe(boardId)
    expect(otherWorkspaceId).not.toBe(workspaceId)
    db.close()
  })

  it('redacts structured metadata at canonical ingress without weakening safe values or conflicts', () => {
    const db = openDb(':memory:')
    const { boardId, sessionId } = seedScope(db)
    const profiles = new AgentProfileService(db)
    const conversations = new ConversationService(db)
    const profile = profiles.create({
      boardId,
      name: 'Metadata-safe builder',
      actor,
      idempotencyKey: 'profile:create:metadata-safe',
    })
    const conversation = conversations.listConversations(profile.id)[0]
    conversations.linkSession(sessionId, {
      profileId: profile.id,
      conversationId: conversation.id,
      mode: 'managed',
      providerThreadId: 'thread-metadata-safe',
      actor,
      idempotencyKey: 'session:link:metadata-safe',
    })

    const privateKey = [
      '-----BEGIN PRIVATE KEY-----',
      'domain-private-material-must-not-survive',
      '-----END PRIVATE KEY-----',
    ].join('\n')
    const sentinels = [
      'dXNlcjpwYXNz',
      'domain-cookie-must-not-survive',
      'domain-private-material-must-not-survive',
      'sk-abcdefghijklmnopqrstuvwxyz123456',
      'ghp_abcdefghijklmnopqrstuvwxyz123456',
      'xoxb-abcdefghijklmnopqrstuvwxyz123456',
      'domain-camel-key-must-not-survive',
      'domain-hyphen-token-must-not-survive',
      'domain-short-provider-token-xy12',
      'domain-short-api-key-xy13',
      'domain-withheld-api-key-xy15',
      'YTo',
    ]
    const metadata = {
      note: 'Authorization: Basic dXNlcjpwYXNz',
      shortBasic: 'Authorization: Basic YTo',
      headers: {
        cookie: 'sid=domain-cookie-must-not-survive',
      },
      nested: {
        apiKey: 'domain-camel-key-must-not-survive',
        'refresh-token': 'domain-hyphen-token-must-not-survive',
        keyMaterial: privateKey,
        providerTokens: [
          'sk-abcdefghijklmnopqrstuvwxyz123456',
          'ghp_abcdefghijklmnopqrstuvwxyz123456',
          'xoxb-abcdefghijklmnopqrstuvwxyz123456',
          'domain-short-provider-token-xy12',
        ],
        apiKeys: ['domain-short-api-key-xy13'],
      },
      usage: {
        token_usage: {
          total_tokens: 144,
          input_tokens: 100,
          output_tokens: 44,
          cached_input_tokens: 30,
        },
        token_budget: 2_000,
      },
      safe: {
        status: 'completed',
        enabled: true,
        count: 7,
        empty: null,
      },
    }
    const appended = conversations.appendEvent(sessionId, {
      idempotencyKey: 'event:metadata-safe:first',
      dedupeKey: 'provider:metadata-safe:first',
      kind: 'assistant',
      projectedText: 'Authorization: Basic Og',
      metadata,
      actor: { type: 'agent', id: 'codex' },
    })
    const replay = conversations.appendEvent(sessionId, {
      idempotencyKey: 'event:metadata-safe:first',
      dedupeKey: 'provider:metadata-safe:first',
      kind: 'assistant',
      projectedText: 'Authorization: Basic Og',
      metadata,
      actor: { type: 'agent', id: 'codex' },
    })

    expect(appended).toMatchObject({
      replayed: false,
      event: {
        projected_text: 'Authorization: Basic [REDACTED]',
        redaction_state: 'redacted',
        metadata: {
          note: 'Authorization: Basic [REDACTED]',
          shortBasic: 'Authorization: Basic [REDACTED]',
          headers: { cookie: '[REDACTED]' },
          nested: {
            apiKey: '[REDACTED]',
            'refresh-token': '[REDACTED]',
            keyMaterial: '[REDACTED]',
            providerTokens: '[REDACTED]',
            apiKeys: '[REDACTED]',
          },
          usage: {
            token_usage: {
              total_tokens: 144,
              input_tokens: 100,
              output_tokens: 44,
              cached_input_tokens: 30,
            },
            token_budget: 2_000,
          },
          safe: {
            status: 'completed',
            enabled: true,
            count: 7,
            empty: null,
          },
        },
      },
    })
    expect(replay).toMatchObject({
      replayed: true,
      event: { id: appended.event.id },
    })

    const stored = db.prepare(`SELECT metadata_json, content_hash
      FROM conversation_events WHERE id=?`).get(appended.event.id) as {
      metadata_json: string
      content_hash: string
    }
    expect(stored.content_hash).toMatch(/^[a-f0-9]{64}$/)
    for (const sentinel of sentinels) {
      expect(JSON.stringify(appended)).not.toContain(sentinel)
      expect(stored.metadata_json).not.toContain(sentinel)
    }

    expect(() => conversations.appendEvent(sessionId, {
      idempotencyKey: 'event:metadata-safe:conflict',
      dedupeKey: 'provider:metadata-safe:first',
      kind: 'assistant',
      projectedText: 'Authorization: Basic Og',
      metadata: {
        ...metadata,
        headers: { 'set-cookie': 'sid=conflict-cookie-must-not-survive' },
        tokens: ['conflict-short-token-xy14'],
        safe: { ...metadata.safe, status: 'failed' },
      },
      actor: { type: 'agent', id: 'codex' },
    })).toThrow(/conflict/)
    const conflict = db.prepare(`SELECT received_content_hash, received_metadata_json
      FROM conversation_event_conflicts`).get() as {
      received_content_hash: string
      received_metadata_json: string
    }
    expect(conflict.received_content_hash).toMatch(/^[a-f0-9]{64}$/)
    expect(conflict.received_metadata_json).not.toContain('conflict-cookie-must-not-survive')
    expect(conflict.received_metadata_json).not.toContain('conflict-short-token-xy14')
    expect(JSON.parse(conflict.received_metadata_json)).toMatchObject({
      headers: { 'set-cookie': '[REDACTED]' },
      tokens: '[REDACTED]',
      safe: { status: 'failed' },
    })

    const executableMetadata = conversations.appendEvent(sessionId, {
      idempotencyKey: 'event:metadata-safe:to-json',
      dedupeKey: 'provider:metadata-safe:to-json',
      kind: 'status',
      metadata: {
        toJSON: () => ({
          authentication: 'to-json-auth-must-not-survive',
          safe: 'visible',
        }),
      },
      actor: { type: 'agent', id: 'codex' },
    })
    expect(executableMetadata.event.metadata).toEqual({
      authentication: '[REDACTED]',
      safe: 'visible',
    })
    const withheld = conversations.appendEvent(sessionId, {
      idempotencyKey: 'event:metadata-safe:withheld',
      dedupeKey: 'provider:metadata-safe:withheld',
      kind: 'status',
      projectedText: 'Authorization: Basic Og',
      metadata: {
        apiKeys: ['domain-withheld-api-key-xy15'],
      },
      redactionState: 'withheld',
      actor: { type: 'system', id: 'retention' },
    })
    expect(withheld.event).toMatchObject({
      projected_text: null,
      redaction_state: 'withheld',
      metadata: { apiKeys: '[REDACTED]' },
    })

    const boundaryOverhead = Buffer.byteLength('{"note":""}', 'utf8')
    const boundary = conversations.appendEvent(sessionId, {
      idempotencyKey: 'event:metadata-safe:boundary',
      dedupeKey: 'provider:metadata-safe:boundary',
      kind: 'status',
      metadata: { note: 'x'.repeat(64_000 - boundaryOverhead) },
      actor: { type: 'system', id: 'boundary-test' },
    })
    expect(Buffer.byteLength(JSON.stringify(boundary.event.metadata), 'utf8')).toBe(64_000)
    expect(() => conversations.appendEvent(sessionId, {
      idempotencyKey: 'event:metadata-safe:over-boundary',
      dedupeKey: 'provider:metadata-safe:over-boundary',
      kind: 'status',
      metadata: { note: 'x'.repeat(64_001 - boundaryOverhead) },
      actor: { type: 'system', id: 'boundary-test' },
    })).toThrow(/metadata must be at most 64000 bytes/)

    const durableEvents = db.prepare('SELECT payload FROM os_events').all() as Array<{
      payload: string
    }>
    const durablePayloads = durableEvents.map((event) => event.payload).join('\n')
    for (const sentinel of [
      ...sentinels,
      'conflict-cookie-must-not-survive',
      'conflict-short-token-xy14',
      'to-json-auth-must-not-survive',
    ]) {
      expect(durablePayloads).not.toContain(sentinel)
    }
    db.close()
  })

  it('keeps event replay stable when provider thread metadata is discovered later', () => {
    const db = openDb(':memory:')
    const { boardId, sessionId } = seedScope(db)
    db.prepare('UPDATE agent_sessions SET external_id=NULL WHERE id=?').run(sessionId)
    const profiles = new AgentProfileService(db)
    const conversations = new ConversationService(db)
    const profile = profiles.create({
      boardId,
      name: 'Recoverable builder',
      actor,
      idempotencyKey: 'profile:create:recoverable',
    })
    const conversation = conversations.listConversations(profile.id)[0]
    conversations.linkSession(sessionId, {
      profileId: profile.id,
      conversationId: conversation.id,
      mode: 'managed',
      actor,
      idempotencyKey: 'session:link:recoverable',
    })

    const beforeDiscovery = conversations.appendEvent(sessionId, {
      idempotencyKey: 'event:threadless:first',
      dedupeKey: 'provider:threadless:first',
      kind: 'assistant',
      projectedText: 'Recorded before the provider thread was known',
      actor: { type: 'agent', id: 'codex' },
    })
    expect(() => conversations.appendEvent(sessionId, {
      idempotencyKey: 'event:threadless:conflict-before-discovery',
      dedupeKey: 'provider:threadless:first',
      kind: 'assistant',
      projectedText: 'Conflicting retry before provider discovery',
      actor: { type: 'agent', id: 'codex' },
    })).toThrow(/conflict/)
    const conflictBeforeDiscovery = db.prepare(`SELECT received_content_hash
      FROM conversation_event_conflicts WHERE canonical_event_id=?`).get(
      beforeDiscovery.event.id,
    ) as { received_content_hash: string }
    conversations.appendEvent(sessionId, {
      idempotencyKey: 'event:thread:discovered',
      dedupeKey: 'provider:thread:discovered',
      kind: 'status',
      providerThreadId: 'thread-discovered-after-attach',
      projectedText: 'Provider thread discovered',
      actor: { type: 'system', id: 'recovery' },
    })
    expect(conversations.requireSession(sessionId).provider_thread_id)
      .toBe('thread-discovered-after-attach')

    const replay = conversations.appendEvent(sessionId, {
      idempotencyKey: 'event:threadless:first',
      dedupeKey: 'provider:threadless:first',
      kind: 'assistant',
      projectedText: 'Recorded before the provider thread was known',
      actor: { type: 'agent', id: 'codex' },
    })
    expect(replay).toMatchObject({
      replayed: true,
      event: { id: beforeDiscovery.event.id, sequence: beforeDiscovery.event.sequence },
    })
    expect(() => conversations.appendEvent(sessionId, {
      idempotencyKey: 'event:threadless:conflict-after-discovery',
      dedupeKey: 'provider:threadless:first',
      kind: 'assistant',
      projectedText: 'Conflicting retry before provider discovery',
      actor: { type: 'agent', id: 'codex' },
    })).toThrow(/conflict/)
    expect((db.prepare(
      'SELECT COUNT(*) AS count FROM conversation_event_conflicts',
    ).get() as any).count).toBe(1)
    expect((db.prepare(`SELECT received_content_hash
      FROM conversation_event_conflicts WHERE canonical_event_id=?`).get(
      beforeDiscovery.event.id,
    ) as { received_content_hash: string }).received_content_hash)
      .toBe(conflictBeforeDiscovery.received_content_hash)
    expect(() => conversations.appendEvent(sessionId, {
      idempotencyKey: 'event:threadless:explicit-mismatch',
      dedupeKey: 'provider:threadless:first',
      providerThreadId: 'thread-discovered-after-attach',
      kind: 'assistant',
      projectedText: 'Recorded before the provider thread was known',
      actor: { type: 'agent', id: 'codex' },
    })).toThrow(/conflict/)
    expect((db.prepare(
      'SELECT COUNT(*) AS count FROM conversation_event_conflicts',
    ).get() as any).count).toBe(2)
    db.close()
  })

  it('preserves command replay identities and event ordering after the database is reopened', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-home-reopen-'))
    tempDirectories.push(directory)
    const file = path.join(directory, 'orchestra.db')
    const firstDb = openDb(file)
    const { boardId, sessionId, jobId } = seedScope(firstDb)
    const firstProfiles = new AgentProfileService(firstDb)
    const firstConversations = new ConversationService(firstDb)
    const profile = firstProfiles.create({
      boardId,
      name: 'Persistent builder',
      actor,
      idempotencyKey: 'persistent:profile',
    })
    const conversation = firstConversations.listConversations(profile.id)[0]
    firstConversations.linkSession(sessionId, {
      profileId: profile.id,
      conversationId: conversation.id,
      jobId,
      mode: 'managed',
      historyState: 'complete',
      actor,
      idempotencyKey: 'persistent:link',
    })
    const event = firstConversations.appendEvent(sessionId, {
      idempotencyKey: 'persistent:event',
      dedupeKey: 'persistent:provider-event',
      kind: 'assistant',
      projectedText: 'Durable answer',
      actor: { type: 'agent', id: 'codex' },
    }).event
    firstDb.close()

    const reopened = openDb(file)
    const profiles = new AgentProfileService(reopened)
    const conversations = new ConversationService(reopened)
    expect(profiles.create({
      boardId,
      name: 'Persistent builder',
      actor,
      idempotencyKey: 'persistent:profile',
    }).id).toBe(profile.id)
    expect(conversations.linkSession(sessionId, {
      profileId: profile.id,
      conversationId: conversation.id,
      jobId,
      mode: 'managed',
      historyState: 'complete',
      actor,
      idempotencyKey: 'persistent:link',
    }).id).toBe(sessionId)
    expect(conversations.appendEvent(sessionId, {
      idempotencyKey: 'persistent:event',
      dedupeKey: 'persistent:provider-event',
      kind: 'assistant',
      projectedText: 'Durable answer',
      actor: { type: 'agent', id: 'codex' },
    })).toMatchObject({ replayed: true, event: { id: event.id, sequence: 1 } })
    expect(conversations.listEvents(conversation.id))
      .toEqual([expect.objectContaining({ id: event.id, projected_text: 'Durable answer' })])
    reopened.close()
  })

  it('deterministically backfills legacy agents, conversations, and session history', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-home-backfill-'))
    tempDirectories.push(directory)
    const file = path.join(directory, 'legacy.db')
    const db = new Database(file)
    db.pragma('foreign_keys = ON')
    db.exec(`
      CREATE TABLE boards (
        id INTEGER PRIMARY KEY, project_path TEXT NOT NULL UNIQUE, name TEXT NOT NULL
      );
      CREATE TABLE cards (
        id INTEGER PRIMARY KEY,
        board_id INTEGER NOT NULL REFERENCES boards(id),
        title TEXT NOT NULL,
        column_name TEXT NOT NULL DEFAULT 'backlog'
      );
      CREATE TABLE task_contracts (
        card_id INTEGER PRIMARY KEY REFERENCES cards(id) ON DELETE CASCADE,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE agents (
        id INTEGER PRIMARY KEY,
        board_id INTEGER NOT NULL REFERENCES boards(id),
        name TEXT NOT NULL,
        session_id TEXT,
        status TEXT NOT NULL,
        last_seen TEXT NOT NULL,
        created_at TEXT NOT NULL,
        kind TEXT NOT NULL,
        role TEXT,
        model TEXT,
        effort TEXT,
        provider TEXT,
        access_profile TEXT
      );
      CREATE TABLE agent_usage (
        board_id INTEGER NOT NULL,
        agent_id INTEGER NOT NULL,
        day TEXT NOT NULL,
        PRIMARY KEY (board_id, agent_id, day)
      );
      CREATE TABLE card_events (
        id INTEGER PRIMARY KEY,
        card_id INTEGER NOT NULL REFERENCES cards(id),
        agent_id INTEGER,
        type TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY,
        board_id INTEGER NOT NULL REFERENCES boards(id),
        kind TEXT NOT NULL DEFAULT 'ask',
        body TEXT NOT NULL
      );
      CREATE TABLE message_targets (
        message_id INTEGER NOT NULL,
        agent_id INTEGER NOT NULL,
        PRIMARY KEY (message_id, agent_id)
      );
      CREATE TABLE deliveries (
        message_id INTEGER NOT NULL,
        agent_id INTEGER NOT NULL,
        PRIMARY KEY (message_id, agent_id)
      );
      CREATE TABLE milestones (
        id INTEGER PRIMARY KEY,
        board_id INTEGER NOT NULL REFERENCES boards(id),
        title TEXT NOT NULL
      );
      CREATE TABLE ideas (
        id INTEGER PRIMARY KEY,
        board_id INTEGER NOT NULL REFERENCES boards(id),
        text TEXT NOT NULL
      );
      CREATE TABLE review_decisions (
        id INTEGER PRIMARY KEY,
        board_id INTEGER NOT NULL REFERENCES boards(id),
        card_id INTEGER NOT NULL REFERENCES cards(id),
        decision TEXT NOT NULL,
        decided_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE token_telemetry (
        board_id INTEGER NOT NULL,
        agent_id INTEGER NOT NULL,
        hook_event TEXT NOT NULL,
        day TEXT NOT NULL,
        count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (board_id, agent_id, hook_event, day)
      );
      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY, board_id INTEGER NOT NULL REFERENCES boards(id),
        name TEXT NOT NULL, kind TEXT NOT NULL, root_path TEXT NOT NULL,
        status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE jobs (
        id TEXT PRIMARY KEY, board_id INTEGER NOT NULL, card_id INTEGER,
        workspace_id TEXT, provider TEXT NOT NULL
      );
      CREATE TABLE agent_sessions (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id),
        agent_id INTEGER REFERENCES agents(id) ON DELETE SET NULL,
        provider TEXT NOT NULL,
        external_id TEXT,
        model TEXT,
        status TEXT NOT NULL,
        context_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE os_events (
        id TEXT PRIMARY KEY, board_id INTEGER NOT NULL, workspace_id TEXT, card_id INTEGER,
        session_id TEXT, process_id TEXT, job_id TEXT, contract_id TEXT,
        correlation_id TEXT, causation_id TEXT, idempotency_key TEXT,
        event_version INTEGER NOT NULL DEFAULT 1,
        kind TEXT NOT NULL, source TEXT NOT NULL, payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE artifacts (
        id TEXT PRIMARY KEY, board_id INTEGER NOT NULL, workspace_id TEXT,
        card_id INTEGER, kind TEXT, name TEXT, mime_type TEXT, path TEXT,
        content TEXT, metadata TEXT, created_at TEXT
      );
      CREATE TABLE delivery_reports (
        id TEXT PRIMARY KEY,
        lineage_id TEXT NOT NULL,
        parent_report_id TEXT
          REFERENCES delivery_reports(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
        sequence INTEGER NOT NULL CHECK(sequence > 0),
        board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
        card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
        job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
        session_id TEXT REFERENCES agent_sessions(id) ON DELETE SET NULL,
        workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
        status TEXT NOT NULL DEFAULT 'draft'
          CHECK(status IN ('draft','submitted','verified','accepted','rejected')),
        asked_snapshot TEXT NOT NULL CHECK(json_valid(asked_snapshot)),
        summary TEXT NOT NULL DEFAULT '',
        delivered_items TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(delivered_items)),
        claims_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(claims_json)),
        changed_files TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(changed_files)),
        commits TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(commits)),
        artifact_ids TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(artifact_ids)),
        gaps TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(gaps)),
        created_by TEXT NOT NULL,
        submitted_by TEXT,
        verified_by TEXT,
        accepted_by TEXT,
        rejected_by TEXT,
        acceptance_note TEXT,
        rejection_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        submitted_at TEXT,
        verified_at TEXT,
        accepted_at TEXT,
        rejected_at TEXT,
        CHECK((parent_report_id IS NULL AND sequence=1)
          OR (parent_report_id IS NOT NULL AND sequence>1))
      );
      CREATE TABLE os_schema_migrations (
        id TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO os_schema_migrations (id) VALUES
        ('001-agent-os-kernel'), ('002-runtime-hardening'),
        ('003-provider-session-ownership'), ('004-delivery-trackbook'),
        ('005-delivery-report-revision-cascade'), ('006-canonical-launch-reservations');
      INSERT INTO boards (id, project_path, name) VALUES
        (1, '/legacy-home', 'legacy home'),
        (2, '/legacy-other', 'legacy other');
      INSERT INTO workspaces
        (id, board_id, name, kind, root_path, status, created_at, updated_at)
        VALUES
          ('legacy-workspace', 1, 'legacy', 'shared', '/legacy-home', 'active',
            '2026-07-20T10:00:00.000Z', '2026-07-20T10:00:00.000Z'),
          ('legacy-other-workspace', 2, 'legacy other', 'shared', '/legacy-other', 'active',
            '2026-07-20T10:00:00.000Z', '2026-07-20T10:00:00.000Z');
      INSERT INTO jobs (id, board_id, workspace_id, provider)
        VALUES ('legacy-job', 1, 'legacy-workspace', 'codex');
      INSERT INTO agents
        (id, board_id, name, status, last_seen, created_at, kind, role, model,
         effort, provider, access_profile)
        VALUES
          (41, 1, 'Ambient legacy', 'active', '2026-07-20T12:00:00.000Z',
            '2026-07-20T10:00:00.000Z', 'session', 'worker', 'codex-model',
            'medium', 'codex', 'workspace_write'),
          (42, 1, 'Managed legacy', 'active', '2026-07-20T12:00:00.000Z',
            '2026-07-20T10:00:00.000Z', 'hired', 'worker', 'codex-model',
            'high', 'codex', 'full_access'),
          (43, 1, 'Mismatched legacy', 'active', '2026-07-20T12:00:00.000Z',
            '2026-07-20T10:00:00.000Z', 'hired', 'worker', 'codex-model',
            'medium', 'codex', 'workspace_write');
      INSERT INTO agent_sessions
        (id, workspace_id, agent_id, provider, external_id, model, status,
         context_json, created_at, updated_at)
        VALUES
          ('legacy-ambient-session', 'legacy-workspace', 41, 'codex', 'thread-ambient',
            'codex-model', 'running', '{"driver_id":"codex-driver","last_event_seq":7}',
            '2026-07-20T10:00:00.000Z', '2026-07-20T12:00:00.000Z'),
          ('legacy-managed-session', 'legacy-workspace', 42, 'codex', 'thread-managed',
            'codex-model', 'stopped', '{"job_id":"legacy-job","effort":"max"}',
            '2026-07-20T10:00:00.000Z', '2026-07-20T12:00:00.000Z'),
          ('legacy-mismatched-session', 'legacy-other-workspace', 43, 'codex',
            'thread-mismatched', 'codex-model', 'running',
            '{"driver_id":"driver-x","last_event_seq":9,"effort":"high","access_profile":"read_only"}',
            '2026-07-20T10:00:00.000Z', '2026-07-20T12:00:00.000Z');
      INSERT INTO os_events
        (id, board_id, workspace_id, session_id, kind, source, payload, created_at)
        VALUES ('driver-event', 1, 'legacy-workspace', 'legacy-ambient-session',
          'driver.output', 'legacy', '{}', '2026-07-20T11:00:00.000Z');
    `)

    applyAgentOsMigrations(db)
    applyAgentOsMigrations(db)
    expect((db.prepare('SELECT COUNT(*) AS count FROM os_schema_migrations').get() as any).count)
      .toBe(23)
    expect(db.prepare(`SELECT id, legacy_agent_id, name, provenance_json
      FROM agent_profiles ORDER BY legacy_agent_id`).all()).toEqual([
      expect.objectContaining({
        id: 'legacy-agent:41',
        legacy_agent_id: 41,
        name: 'Ambient legacy',
      }),
      expect.objectContaining({
        id: 'legacy-agent:42',
        legacy_agent_id: 42,
        name: 'Managed legacy',
      }),
      expect.objectContaining({
        id: 'legacy-agent:43',
        legacy_agent_id: 43,
        name: 'Mismatched legacy',
      }),
    ])
    expect(db.prepare(`SELECT id, profile_id, is_default
      FROM agent_conversations ORDER BY profile_id`).all()).toEqual([
      {
        id: 'legacy-conversation:41',
        profile_id: 'legacy-agent:41',
        is_default: 1,
      },
      {
        id: 'legacy-conversation:42',
        profile_id: 'legacy-agent:42',
        is_default: 1,
      },
      {
        id: 'legacy-conversation:43',
        profile_id: 'legacy-agent:43',
        is_default: 1,
      },
    ])
    expect(db.prepare(`SELECT id, profile_id, conversation_id, job_id, mode, status,
      driver_id, effort, access_profile, provider_thread_id, provider_cursor, recovery_state,
      history_state, started_at, ended_at
      FROM agent_sessions ORDER BY id`).all()).toEqual([
      expect.objectContaining({
        id: 'legacy-ambient-session',
        profile_id: 'legacy-agent:41',
        conversation_id: 'legacy-conversation:41',
        job_id: null,
        mode: 'ambient',
        driver_id: 'codex-driver',
        provider_thread_id: 'thread-ambient',
        provider_cursor: '7',
        recovery_state: 'attachable',
        history_state: 'partial',
        ended_at: null,
      }),
      expect.objectContaining({
        id: 'legacy-managed-session',
        profile_id: 'legacy-agent:42',
        conversation_id: 'legacy-conversation:42',
        job_id: 'legacy-job',
        mode: 'managed',
        effort: 'max',
        provider_thread_id: 'thread-managed',
        recovery_state: 'attachable',
        history_state: 'unavailable',
        ended_at: '2026-07-20T12:00:00.000Z',
      }),
      expect.objectContaining({
        id: 'legacy-mismatched-session',
        profile_id: null,
        conversation_id: null,
        job_id: null,
        mode: 'compatibility',
        status: 'lost',
        driver_id: 'driver-x',
        effort: 'high',
        access_profile: 'read_only',
        provider_thread_id: 'thread-mismatched',
        provider_cursor: '9',
        recovery_state: 'lost',
        history_state: 'unavailable',
        started_at: '2026-07-20T10:00:00.000Z',
        ended_at: '2026-07-20T12:00:00.000Z',
      }),
    ])
    expect(JSON.parse((db.prepare(`SELECT recovery_json FROM agent_sessions
      WHERE id='legacy-mismatched-session'`).get() as any).recovery_json)).toEqual({
      source: 'legacy_backfill',
      reason: 'agent_workspace_board_mismatch',
    })

    db.prepare('DELETE FROM agents WHERE id=41').run()
    expect(db.prepare("SELECT id, legacy_agent_id FROM agent_profiles WHERE id='legacy-agent:41'").get())
      .toEqual({ id: 'legacy-agent:41', legacy_agent_id: null })
    db.close()

    const reopened = new Database(file)
    reopened.pragma('foreign_keys = ON')
    applyAgentOsMigrations(reopened)
    expect((reopened.prepare('SELECT COUNT(*) AS count FROM agent_profiles').get() as any).count)
      .toBe(3)
    expect((reopened.prepare('SELECT COUNT(*) AS count FROM agent_conversations').get() as any).count)
      .toBe(3)
    reopened.close()
  })
})

function seedScope(db: Database.Database): {
  boardId: number
  otherBoardId: number
  workspaceId: string
  otherWorkspaceId: string
  sessionId: string
  otherSessionId: string
  jobId: string
  artifactId: string
  otherArtifactId: string
} {
  const boardId = Number(db.prepare(
    "INSERT INTO boards (project_path, name) VALUES ('/agent-home-primary', 'primary')",
  ).run().lastInsertRowid)
  const otherBoardId = Number(db.prepare(
    "INSERT INTO boards (project_path, name) VALUES ('/agent-home-other', 'other')",
  ).run().lastInsertRowid)
  const workspaceId = 'agent-home-workspace'
  const otherWorkspaceId = 'agent-home-workspace-other'
  db.prepare(`INSERT INTO workspaces
    (id, board_id, name, kind, root_path, status)
    VALUES (?, ?, 'home', 'shared', '/agent-home-primary', 'active')`)
    .run(workspaceId, boardId)
  db.prepare(`INSERT INTO workspaces
    (id, board_id, name, kind, root_path, status)
    VALUES (?, ?, 'other', 'shared', '/agent-home-other', 'active')`)
    .run(otherWorkspaceId, otherBoardId)
  const sessionId = 'agent-home-session'
  const otherSessionId = 'agent-home-session-other'
  db.prepare(`INSERT INTO agent_sessions
    (id, workspace_id, provider, external_id, model, status, context_json)
    VALUES (?, ?, 'codex', 'thread-1', 'codex-model', 'running', '{}')`)
    .run(sessionId, workspaceId)
  db.prepare(`INSERT INTO agent_sessions
    (id, workspace_id, provider, external_id, model, status, context_json)
    VALUES (?, ?, 'claude', 'thread-other', 'claude-model', 'running', '{}')`)
    .run(otherSessionId, otherWorkspaceId)
  const jobId = 'job-primary'
  db.prepare(`INSERT INTO jobs
    (id, board_id, workspace_id, provider, status)
    VALUES (?, ?, ?, 'codex', 'running')`).run(jobId, boardId, workspaceId)
  db.prepare(`INSERT INTO jobs
    (id, board_id, workspace_id, provider, status)
    VALUES ('job-other', ?, ?, 'claude', 'running')`).run(otherBoardId, otherWorkspaceId)
  const artifactId = 'artifact-primary'
  const otherArtifactId = 'artifact-other'
  db.prepare(`INSERT INTO artifacts
    (id, board_id, workspace_id, kind, name, mime_type, metadata)
    VALUES (?, ?, ?, 'transcript', 'primary.json', 'application/json', '{}')`)
    .run(artifactId, boardId, workspaceId)
  db.prepare(`INSERT INTO artifacts
    (id, board_id, workspace_id, kind, name, mime_type, metadata)
    VALUES (?, ?, ?, 'transcript', 'other.json', 'application/json', '{}')`)
    .run(otherArtifactId, otherBoardId, otherWorkspaceId)
  return {
    boardId,
    otherBoardId,
    workspaceId,
    otherWorkspaceId,
    sessionId,
    otherSessionId,
    jobId,
    artifactId,
    otherArtifactId,
  }
}
