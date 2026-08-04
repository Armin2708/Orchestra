import { describe, expect, it } from 'vitest'
import {
  answeredByYou,
  buildMessagePayload,
  deliverySummary,
  inboxMatches,
  isUnread,
  latestForeignId,
  mailboxOf,
  mailExpectsReply,
  mailType,
  messageRoute,
  needsAttention,
  parseAttachments,
  splitSubject,
  subjectOf,
  swarmRecipientCount,
  threadMatches,
} from '../web/src/messageUi.js'

const message = (overrides: Record<string, unknown> = {}) => ({
  id: 1, board_id: 1, card_id: null, kind: 'ask' as const, body: 'Question?',
  from_name: 'amber-fox', to_name: null, reply_to: null,
  created_at: '2026-07-19 12:00:00', delivered_at: null,
  recipient_count: 0, delivered_count: 0, answered: false, replies: [],
  ...overrides,
})

describe('message UI semantics', () => {
  it('builds targeted and targetless payloads without leaking contradictory fields', () => {
    expect(buildMessagePayload({ boardId: 3, kind: 'ask', body: '  Is the API final?  ', to: 'amber-fox', cardId: 8 }))
      .toEqual({ board_id: 3, kind: 'ask', body: 'Is the API final?', to: 'amber-fox', card_id: 8 })
    expect(buildMessagePayload({ boardId: 3, kind: 'announce', body: 'Release is ready', to: 'ignored' }))
      .toEqual({ board_id: 3, kind: 'announce', body: 'Release is ready' })
    expect(buildMessagePayload({ boardId: 3, kind: 'swarm', body: 'Audit', confirm: true }))
      .toEqual({ board_id: 3, kind: 'swarm', body: 'Audit', confirm: true })
    expect(() => buildMessagePayload({ boardId: 3, kind: 'notify', body: 'Heads up' }))
      .toThrow('Notify needs one recipient')
  })

  it('explains zero-wake and mechanical-delivery states', () => {
    expect(deliverySummary(message({ kind: 'announce' }))).toMatchObject({ label: 'Board only', detail: 'No agents woken' })
    expect(deliverySummary(message({ kind: 'notify' }))).toMatchObject({ label: 'Queued', detail: expect.stringContaining('no wake') })
    expect(deliverySummary(message({ kind: 'swarm', recipient_count: 4, delivered_count: 3 }))).toMatchObject({ label: '3/4 delivered' })
    expect(deliverySummary(message({ kind: 'ask', answered: true }))).toMatchObject({ label: 'Answered' })
  })

  it('separates open questions, updates, and action messages', () => {
    expect(threadMatches(message() as any, 'open')).toBe(true)
    expect(threadMatches(message({ answered: true }) as any, 'open')).toBe(false)
    expect(threadMatches(message({ kind: 'announce' }) as any, 'updates')).toBe(true)
    expect(threadMatches(message({ kind: 'notify' }) as any, 'updates')).toBe(true)
    expect(threadMatches(message({ kind: 'task' }) as any, 'actions')).toBe(true)
    expect(threadMatches(message({ kind: 'swarm' }) as any, 'actions')).toBe(true)
  })

  it('names human, board, and swarm endpoints precisely', () => {
    expect(messageRoute(message({ kind: 'ask' }))).toEqual({ from: 'amber-fox', to: 'You' })
    expect(messageRoute(message({ kind: 'announce' }))).toEqual({ from: 'amber-fox', to: 'Board' })
    expect(messageRoute(message({ kind: 'swarm' }))).toEqual({ from: 'amber-fox', to: 'Live agents' })
  })

  it('reads the first line as the subject and the rest as the snippet', () => {
    expect(splitSubject('Deploy blocked\nThe staging cert expired; need a decision.'))
      .toEqual({ subject: 'Deploy blocked', snippet: 'The staging cert expired; need a decision.' })
    expect(splitSubject('single line')).toEqual({ subject: 'single line', snippet: '' })
    expect(splitSubject('  ')).toMatchObject({ subject: '(no subject)' })
    const long = splitSubject('x'.repeat(200))
    expect(long.subject.length).toBeLessThanOrEqual(120)
    expect(long.subject.endsWith('…')).toBe(true)
    expect(long.snippet.startsWith('…')).toBe(true)
  })

  it('inbox holds only mail explicitly addressed to the operator', () => {
    expect(mailboxOf(message({ to_human: 1 }) as any)).toBe('inbox')
    expect(mailboxOf(message() as any)).toBe('board') // targetless broadcast = coordination noise
    expect(mailboxOf(message({ to_name: 'jade-lynx' }) as any)).toBe('board') // agent ↔ agent
    expect(mailboxOf(message({ from_name: null }) as any)).toBe('sent') // you wrote the root
  })

  it('typed mail queues only when it expects something from you', () => {
    const mail = (over: Record<string, unknown> = {}) => message({ to_human: 1, ...over }) as any
    expect(inboxMatches(mail({ mail_type: 'question' }), 'needs_reply')).toBe(true)
    expect(inboxMatches(mail({ mail_type: 'action' }), 'needs_reply')).toBe(true)
    expect(inboxMatches(mail({ mail_type: 'blocker' }), 'needs_reply')).toBe(true)
    expect(inboxMatches(mail({ mail_type: 'update' }), 'needs_reply')).toBe(false)
    expect(inboxMatches(mail({ mail_type: 'fyi' }), 'needs_reply')).toBe(false)
    // a bare `ask human` has no mail_type — it is a question by nature
    expect(mailType(mail())).toBe('question')
    expect(mailExpectsReply(mail())).toBe(true)
    expect(inboxMatches(mail({ replies: [message({ id: 2, from_name: null, kind: 'reply' })] }), 'needs_reply')).toBe(false)
    // another agent chiming in does not clear your queue — only your reply does
    expect(inboxMatches(mail({ replies: [message({ id: 2, kind: 'reply' })] }), 'needs_reply')).toBe(true)
    expect(answeredByYou(message({ replies: [message({ id: 2, from_name: null, kind: 'reply' })] }) as any)).toBe(true)
  })

  it('prefers the explicit subject and parses attachments defensively', () => {
    expect(subjectOf({ subject: 'Cert expired', body: 'first line\nrest' })).toBe('Cert expired')
    expect(subjectOf({ subject: null, body: 'first line\nrest' })).toBe('first line')
    expect(parseAttachments({ attachments: JSON.stringify([
      { type: 'file', ref: 'src/server.ts' }, { type: 'card', ref: '12' },
      { type: 'bogus', ref: 'x' }, { type: 'url' },
    ]) })).toEqual([{ type: 'file', ref: 'src/server.ts' }, { type: 'card', ref: '12' }])
    expect(parseAttachments({ attachments: 'not json' })).toEqual([])
    expect(parseAttachments({ attachments: null })).toEqual([])
  })

  it('computes unread from the newest agent-authored message id', () => {
    const t = message({ id: 5, replies: [message({ id: 9, kind: 'reply' })] }) as any
    expect(latestForeignId(t)).toBe(9)
    expect(isUnread(t, 1, {})).toBe(true)
    expect(isUnread(t, 1, { '1:5': 9 })).toBe(false)
    expect(isUnread(t, 1, { '1:5': 5 })).toBe(true) // a newer agent reply re-unreads
    // your own sent thread with no agent replies never shows unread
    expect(isUnread(message({ from_name: null }) as any, 1, {})).toBe(false)
  })

  it('badges only operator mail — never agent↔agent board traffic (#126)', () => {
    const inboxMail = message({ id: 5, to_human: 1, mail_type: 'action' }) as any
    // unanswered operator mail badges even after it was read
    expect(needsAttention(inboxMail, 1, {})).toBe(true)
    expect(needsAttention(inboxMail, 1, { '1:5': 5 })).toBe(true)
    // an operator reply clears it (read + answered)
    const answered = { ...inboxMail, replies: [message({ id: 9, kind: 'reply', from_name: null })] }
    expect(needsAttention(answered, 1, { '1:5': 5 })).toBe(false)
    // FYI mail badges only while unread
    const fyi = message({ id: 6, to_human: 1, mail_type: 'fyi' }) as any
    expect(needsAttention(fyi, 1, {})).toBe(true)
    expect(needsAttention(fyi, 1, { '1:6': 6 })).toBe(false)
    // the old badge bug: an unanswered agent→agent ask must not badge
    expect(needsAttention(message({ id: 7, to_name: 'teal-ibex' }) as any, 1, {})).toBe(false)
    // your own sent mail never badges
    expect(needsAttention(message({ id: 8, from_name: null, to_human: 1 }) as any, 1, {})).toBe(false)
  })

  it('counts only agents a confirmed swarm can currently wake', () => {
    expect(swarmRecipientCount([
      { id: 1, name: 'a', status: 'active', last_seen: '' },
      { id: 2, name: 'b', status: 'idle', last_seen: '' },
      { id: 3, name: 'c', status: 'paused_limit', last_seen: '' },
      { id: 4, name: 'd', status: 'gone', last_seen: '' },
    ])).toBe(2)
  })
})
