import { describe, expect, it } from 'vitest'
import { presentMessage, type MessagePresentationTokenKind } from '../web/src/messagePresentation.js'

const tokensOf = (body: string, kind: MessagePresentationTokenKind, cardTitles?: ReadonlyMap<number, string>) =>
  presentMessage({ body, kind: 'ask' }, { cardTitles }).clauses.flat().filter((token) => token.kind === kind)

describe('human-readable message presentation', () => {
  it('expands acknowledgements and resolves card and commit references without changing raw bytes', () => {
    const raw = 'Ack — #57=4f9bd2b noted; #62 is the sole remaining pre-freeze gate.'
    const presentation = presentMessage({ body: raw, kind: 'ask' }, {
      cardTitles: new Map([[57, 'Ship integration'], [62, 'Auto-wake gate']]),
    })

    expect(presentation.raw).toBe(raw)
    expect(presentation.heading).toBe('Acknowledged update')
    expect(presentation.tone).toBe('receipt')
    expect(presentation.clauses).toHaveLength(2)
    expect(presentation.clauses.flat().filter((token) => token.kind === 'receipt').map((token) => token.label))
      .toEqual(['Acknowledged', 'Noted'])
    expect(presentation.clauses.flat().filter((token) => token.kind === 'card'))
      .toMatchObject([
        { cardId: 57, cardTitle: 'Ship integration' },
        { cardId: 62, cardTitle: 'Auto-wake gate' },
      ])
    expect(presentation.clauses.flat().find((token) => token.kind === 'commit'))
      .toMatchObject({ value: '4f9bd2b', text: '4f9bd2b' })
    expect(presentation.clauses.flat().find((token) => token.kind === 'status'))
      .toMatchObject({ label: 'Gate', tone: 'attention' })
  })

  it('annotates branch, worktree, merge, and unlinked card references', () => {
    const raw = '#59 merge-ready: feat/59-autoship @ 2e01c83 (worktree ../agentboard-59).'
    const presentation = presentMessage({ body: raw, kind: 'notify' })

    expect(presentation.raw).toBe(raw)
    expect(presentation.heading).toBe('Merge update')
    expect(tokensOf(raw, 'card')).toMatchObject([{ cardId: 59, cardTitle: null }])
    expect(tokensOf(raw, 'branch')).toMatchObject([{ value: 'feat/59-autoship' }])
    expect(tokensOf(raw, 'commit')).toMatchObject([{ value: '2e01c83' }])
    expect(tokensOf(raw, 'path')).toMatchObject([{ value: '../agentboard-59' }])
  })

  it.each([
    ['⚠ undeliverable: agent left before reading.', 'Delivery failed', 'danger'],
    ['No collision — proceed with the merge.', 'No conflict reported', 'positive'],
    ['Card #8 is blocked on the release gate.', 'Blocker or gate update', 'attention'],
    ['Verification failed after the final run.', 'Failure reported', 'danger'],
    ['All checks green and complete.', 'Completion update', 'positive'],
  ] as const)('classifies common protocol status: %s', (body, heading, tone) => {
    const presentation = presentMessage({ body, kind: 'ask' })
    expect(presentation.raw).toBe(body)
    expect(presentation).toMatchObject({ heading, tone })
    expect(presentation.annotated).toBe(true)
  })

  it('leaves unknown syntax verbatim and does not guess numeric, word-only, or color hashes', () => {
    const raw = 'opaque::x|y version 1234567 deadbeef color #abc1234'
    const presentation = presentMessage({ body: raw, kind: 'ask' })

    expect(presentation).toMatchObject({
      raw,
      heading: 'Coordination message',
      tone: 'neutral',
      annotated: false,
    })
    expect(presentation.clauses).toEqual([[{ kind: 'text', text: raw }]])
  })

  it('preserves hostile markup and multiline protocol exactly while making lines scannable', () => {
    const raw = 'first <script>alert("x")</script>\nsecond & final'
    const presentation = presentMessage({ body: raw, kind: 'announce' })

    expect(presentation.raw).toBe(raw)
    expect(presentation.clauses).toHaveLength(2)
    expect(presentation.clauses.flat().map((token) => token.text).join(''))
      .toContain('<script>alert("x")</script>')
  })

  it('uses intent-aware headings when a packet has no recognized protocol vocabulary', () => {
    expect(presentMessage({ body: 'Please inspect this', kind: 'task' }).heading).toBe('Action requested')
    expect(presentMessage({ body: 'What changed?', kind: 'ask' }).heading).toBe('Question')
    expect(presentMessage({ body: 'For the record', kind: 'announce' }).heading).toBe('Announcement')
    expect(presentMessage({ body: 'Returned context', kind: 'reply' }).heading).toBe('Reply')
  })
})
