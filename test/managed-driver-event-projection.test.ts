import { describe, expect, it } from 'vitest'
import { projectManagedDriverEvent } from '../src/agent-os/managed-driver-event-projection.js'

describe('managed driver event projection', () => {
  it('infers a method-only approval and drops every raw request-derived field', () => {
    expect(projectManagedDriverEvent({
      seq: 7,
      data: 'raw approval message',
      metadata: {
        provider: 'codex',
        nativeMethod: 'future/non-sensitive',
        method: 'item/commandExecution/requestApproval',
        native: { command: 'secret command' },
        questions: [{ question: 'secret question' }],
      },
    }, 'codex')).toEqual({
      classification: 'approval',
      payload: {
        seq: 7,
        data: 'Codex command approval requested',
        metadata: {
          approval: true,
          kind: 'approval',
          approvalKind: 'command',
          approvalPayloadState: 'withheld',
        },
      },
    })
  })

  it.each([
    'item/reasoning/summaryTextDelta',
    'item/reasoning/summaryPartAdded',
    'item/reasoning/textDelta',
  ])('withholds reasoning method %s', (method) => {
    const projection = projectManagedDriverEvent({
      seq: 8,
      data: 'private reasoning must not survive',
      metadata: {
        provider: 'codex',
        nativeMethod: 'future/non-sensitive',
        method,
        native: { delta: 'private reasoning must not survive' },
      },
    }, 'codex')
    expect(projection).toEqual({
      classification: 'reasoning',
      payload: {
        seq: 8,
        data: 'Codex reasoning withheld',
        metadata: {
          reasoning: true,
          reasoningPayloadState: 'withheld',
          rawPayloadState: 'withheld',
        },
      },
    })
  })

  it('redacts ordinary text and keeps only bounded presentation metadata', () => {
    const credential = 'sk-proj-ORDINARY_OUTPUT_SECRET_1a2b'
    const projection = projectManagedDriverEvent({
      seq: 9,
      data: `Visible answer using ${credential}`,
      metadata: {
        provider: 'codex',
        nativeMethod: 'item/agentMessage/delta',
        method: 'item/agentMessage/delta',
        itemId: 'message-1',
        plan: [{ text: credential }, { text: 'safe' }],
        subagents: { receiverThreadIds: ['child-1'] },
        native: { delta: `Visible answer using ${credential}` },
        arbitrary: { secret: credential },
      },
    }, 'codex')
    expect(projection).toEqual({
      classification: 'ordinary',
      payload: {
        seq: 9,
        data: 'Visible answer using [REDACTED]',
        metadata: {
          provider: 'codex',
          itemId: 'message-1',
          nativeMethod: 'item/agentMessage/delta',
          method: 'item/agentMessage/delta',
          plan: [null, null],
          subagents: { receiverThreadIds: ['child-1'] },
          rawPayloadState: 'withheld',
          redactionState: 'redacted',
        },
      },
    })
    expect(JSON.stringify(projection)).not.toContain(credential)
    expect(projection.payload.metadata).not.toHaveProperty('native')
    expect(projection.payload.metadata).not.toHaveProperty('arbitrary')
  })

  it('withholds Claude thinking projections even without a native method', () => {
    expect(projectManagedDriverEvent({
      seq: 10,
      data: 'private Claude thinking',
      metadata: { transcriptKind: 'thinking' },
    }, 'claude')).toMatchObject({
      classification: 'reasoning',
      payload: {
        data: 'Claude reasoning withheld',
        metadata: { reasoningPayloadState: 'withheld' },
      },
    })
  })

  it('does not claim a redaction when safe text contains a literal placeholder', () => {
    const projection = projectManagedDriverEvent({
      seq: 11,
      data: 'Documentation uses the literal placeholder [REDACTED].',
      metadata: { provider: 'codex', nativeMethod: 'item/agentMessage/delta' },
    }, 'codex')
    expect(projection.payload.data).toBe('Documentation uses the literal placeholder [REDACTED].')
    expect(projection.payload.metadata).not.toHaveProperty('redactionState')
  })

  it('redacts a private key before applying the durable size limit', () => {
    const body = `private-key-body-${'x'.repeat(9_000)}`
    const pem = `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`
    const projection = projectManagedDriverEvent({
      seq: 12,
      data: pem,
      metadata: { provider: 'codex', nativeMethod: 'item/agentMessage/delta' },
    }, 'codex')
    expect(projection.payload.data).toBe('[REDACTED]')
    expect(projection.payload.metadata).toMatchObject({ redactionState: 'redacted' })
    expect(JSON.stringify(projection)).not.toContain('BEGIN PRIVATE KEY')
    expect(JSON.stringify(projection)).not.toContain('private-key-body')
    expect(JSON.stringify(projection)).not.toContain('END PRIVATE KEY')
  })
})
