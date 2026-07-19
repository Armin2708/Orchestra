import type { BoardMessage, MessageKind } from './api'

export type MessagePresentationTone = 'neutral' | 'receipt' | 'positive' | 'attention' | 'danger'
export type MessagePresentationTokenKind = 'text' | 'receipt' | 'card' | 'commit' | 'branch' | 'path' | 'status'

export type MessagePresentationToken = {
  kind: MessagePresentationTokenKind
  text: string
  label?: string
  value?: string
  cardId?: number
  cardTitle?: string | null
  tone?: MessagePresentationTone
}

export type MessagePresentation = {
  raw: string
  heading: string
  tone: MessagePresentationTone
  clauses: MessagePresentationToken[][]
  annotated: boolean
}

export type MessagePresentationContext = {
  cardTitles?: ReadonlyMap<number, string>
}

type PresentableMessage = Pick<BoardMessage, 'body' | 'kind'> | { body: string; kind?: MessageKind }

const TOKEN_PATTERN = /(#(\d+))|((?<![A-Za-z0-9#/:])@?(?=[0-9a-f]{7,40}\b)(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b)|((?<![/:A-Za-z0-9])(?:feat|feature|fix|hotfix|release|codex)\/[A-Za-z0-9._/-]*[A-Za-z0-9_-])|((?<![:/A-Za-z0-9])(?:\.\.?\/|\/)[A-Za-z0-9._~@+/-]*[A-Za-z0-9_~@+-])|(\b(?:acknowledged|ack|noted|tracked|recorded)\b)|(\b(?:no blockers?|no collision|no conflict|not ready|merge-ready|main advanced|undeliverable|blockers?|blocked|gates?|gated|merged|green|passes?|passed|failed|failure|ready|complete|completed|done|collision|conflict)\b)/gi

const receiptLabel = (text: string) => {
  switch (text.toLowerCase()) {
    case 'ack':
    case 'acknowledged': return 'Acknowledged'
    case 'noted': return 'Noted'
    case 'tracked': return 'Tracked'
    default: return 'Recorded'
  }
}

function statusPresentation(text: string): Pick<MessagePresentationToken, 'label' | 'tone'> {
  switch (text.toLowerCase()) {
    case 'no blocker':
    case 'no blockers': return { label: 'No blockers', tone: 'positive' }
    case 'no collision': return { label: 'No collision', tone: 'positive' }
    case 'no conflict': return { label: 'No conflict', tone: 'positive' }
    case 'main advanced': return { label: 'Main branch advanced', tone: 'positive' }
    case 'merge-ready': return { label: 'Ready to merge', tone: 'positive' }
    case 'merged': return { label: 'Merged', tone: 'positive' }
    case 'green': return { label: 'Checks green', tone: 'positive' }
    case 'pass':
    case 'passes':
    case 'passed': return { label: 'Passed', tone: 'positive' }
    case 'complete':
    case 'completed': return { label: 'Complete', tone: 'positive' }
    case 'done': return { label: 'Done', tone: 'positive' }
    case 'ready': return { label: 'Ready', tone: 'positive' }
    case 'not ready': return { label: 'Not ready', tone: 'attention' }
    case 'blocker':
    case 'blockers': return { label: 'Blocker', tone: 'attention' }
    case 'blocked': return { label: 'Blocked', tone: 'attention' }
    case 'gate':
    case 'gates':
    case 'gated': return { label: 'Gate', tone: 'attention' }
    case 'undeliverable': return { label: 'Delivery failed', tone: 'danger' }
    case 'failed':
    case 'failure': return { label: 'Failed', tone: 'danger' }
    case 'collision': return { label: 'Collision', tone: 'danger' }
    default: return { label: 'Conflict', tone: 'danger' }
  }
}

function splitClauses(body: string) {
  const source = body.trim()
  if (!source) return ['']
  return source
    .replace(/\r\n/g, '\n')
    .split(/\n+|;\s+(?=\S)/)
    .flatMap((part) => part.length > 220
      ? part.split(/(?<=[.!?])\s+(?=[A-Z#⚠])/)
      : [part])
    .map((part) => part.trim())
    .filter(Boolean)
}

function tokenizeClause(clause: string, context: MessagePresentationContext): MessagePresentationToken[] {
  const tokens: MessagePresentationToken[] = []
  const pattern = new RegExp(TOKEN_PATTERN.source, TOKEN_PATTERN.flags)
  let cursor = 0
  let match: RegExpExecArray | null

  while ((match = pattern.exec(clause)) !== null) {
    if (match.index > cursor) tokens.push({ kind: 'text', text: clause.slice(cursor, match.index) })
    const text = match[0]
    if (match[1]) {
      const cardId = Number(match[2])
      tokens.push({
        kind: 'card', text, cardId,
        cardTitle: context.cardTitles?.get(cardId) ?? null,
      })
    } else if (match[3]) {
      tokens.push({ kind: 'commit', text, value: text.replace(/^@/, '') })
    } else if (match[4]) {
      tokens.push({ kind: 'branch', text, value: text })
    } else if (match[5]) {
      tokens.push({ kind: 'path', text, value: text })
    } else if (match[6]) {
      tokens.push({ kind: 'receipt', text, label: receiptLabel(text), tone: 'receipt' })
    } else {
      tokens.push({ kind: 'status', text, ...statusPresentation(text) })
    }
    cursor = match.index + text.length
  }

  if (cursor < clause.length) tokens.push({ kind: 'text', text: clause.slice(cursor) })
  return tokens.length > 0 ? tokens : [{ kind: 'text', text: clause }]
}

function presentationHeading(body: string, kind: MessageKind): Pick<MessagePresentation, 'heading' | 'tone'> {
  const source = body.trim()
  if (/\bundeliverable\b/i.test(source)) return { heading: 'Delivery failed', tone: 'danger' }

  const receipt = source.match(/^(acknowledged|ack|noted|tracked|recorded)\b/i)?.[1]
  if (receipt) return { heading: `${receiptLabel(receipt)} update`, tone: 'receipt' }

  if (/\bno (?:blockers?|collision|conflict)\b/i.test(source)) return { heading: 'No conflict reported', tone: 'positive' }
  if (/\bmain advanced\b/i.test(source)) return { heading: 'Main branch advanced', tone: 'positive' }
  if (/\b(?:not ready|blocked|blockers?|gates?|gated)\b/i.test(source)) return { heading: 'Blocker or gate update', tone: 'attention' }
  if (/\b(?:merged|merge-ready)\b/i.test(source)) return { heading: 'Merge update', tone: 'positive' }
  if (/\b(?:failed|failure)\b/i.test(source)) return { heading: 'Failure reported', tone: 'danger' }
  if (/\b(?:green|passes?|passed|complete|completed|done)\b/i.test(source)) return { heading: 'Completion update', tone: 'positive' }

  switch (kind) {
    case 'reply': return { heading: 'Reply', tone: 'neutral' }
    case 'task': return { heading: 'Action requested', tone: 'attention' }
    case 'notify': return { heading: 'Update', tone: 'neutral' }
    case 'announce': return { heading: 'Announcement', tone: 'neutral' }
    case 'swarm': return { heading: 'Team request', tone: 'attention' }
    default: return source.includes('?')
      ? { heading: 'Question', tone: 'neutral' }
      : { heading: 'Coordination message', tone: 'neutral' }
  }
}

export function presentMessage(message: PresentableMessage, context: MessagePresentationContext = {}): MessagePresentation {
  const raw = message.body
  const clauses = splitClauses(raw).map((clause) => tokenizeClause(clause, context))
  const heading = presentationHeading(raw, message.kind ?? 'ask')
  return {
    raw,
    ...heading,
    clauses,
    annotated: clauses.length > 1 || clauses.some((clause) => clause.some((token) => token.kind !== 'text')),
  }
}
