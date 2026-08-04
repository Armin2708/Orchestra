import type { Agent, BoardMessage, MessageKind, Thread } from './api'

export type ComposeKind = Exclude<MessageKind, 'reply'>
export type MessageFilter = 'all' | 'open' | 'questions' | 'updates' | 'actions'
export type DeliveryTone = 'open' | 'done' | 'quiet' | 'pending'

export type MessageKindMeta = {
  label: string
  action: string
  hint: string
  wakes: string
  needsTarget: boolean
  tone: DeliveryTone
}

export const MESSAGE_KIND_META: Record<MessageKind, MessageKindMeta> = {
  ask: {
    label: 'Ask', action: 'Send question',
    hint: 'One agent answers with a substantive response.', wakes: 'Wakes one agent',
    needsTarget: true, tone: 'open',
  },
  reply: {
    label: 'Answer', action: 'Send answer',
    hint: 'Continues the thread without requesting an acknowledgment.', wakes: 'Returns to the sender',
    needsTarget: false, tone: 'done',
  },
  task: {
    label: 'Task', action: 'Assign task',
    hint: 'One agent acts; an acknowledgment-only reply is not requested.', wakes: 'Wakes one agent',
    needsTarget: true, tone: 'pending',
  },
  notify: {
    label: 'Notify', action: 'Queue notification',
    hint: 'Included in the agent\'s next natural turn.', wakes: 'Does not wake',
    needsTarget: true, tone: 'quiet',
  },
  announce: {
    label: 'Announce', action: 'Post announcement',
    hint: 'Visible in board history for people and agents to find later.', wakes: 'Does not wake',
    needsTarget: false, tone: 'quiet',
  },
  swarm: {
    label: 'Swarm', action: 'Review swarm',
    hint: 'Snapshots the currently available agents and sends the same work once.', wakes: 'Wakes the live fleet',
    needsTarget: false, tone: 'pending',
  },
}

export const COMPOSE_KINDS: ComposeKind[] = ['ask', 'task', 'notify', 'announce', 'swarm']

export const messageKind = (message: Pick<BoardMessage, 'kind'> | { kind?: MessageKind }): MessageKind =>
  message.kind ?? 'ask'

export function messageRoute(message: Pick<BoardMessage, 'kind' | 'from_name' | 'to_name'>) {
  const kind = messageKind(message)
  const from = message.from_name ?? 'You'
  const to = message.to_name
    ?? (kind === 'swarm' ? 'Live agents' : kind === 'announce' ? 'Board' : kind === 'ask' ? 'You' : 'Board')
  return { from, to }
}

export function deliverySummary(message: Pick<BoardMessage,
  'kind' | 'delivered_at' | 'recipient_count' | 'delivered_count'> & { answered?: boolean }) {
  const kind = messageKind(message)
  const recipients = Number(message.recipient_count ?? 0)
  const delivered = Number(message.delivered_count ?? 0)
  if (kind === 'announce') return { label: 'Board only', detail: 'No agents woken', tone: 'quiet' as const }
  if (kind === 'notify') return message.delivered_at || delivered > 0
    ? { label: 'Included', detail: 'Delivered with a natural turn', tone: 'done' as const }
    : { label: 'Queued', detail: 'Waiting for a natural turn; no wake', tone: 'quiet' as const }
  if (kind === 'swarm') return recipients === 0
    ? { label: 'No recipients', detail: 'No available agents were snapshotted', tone: 'quiet' as const }
    : { label: `${delivered}/${recipients} delivered`, detail: `${recipients} snapshotted recipient${recipients === 1 ? '' : 's'}`, tone: delivered === recipients ? 'done' as const : 'pending' as const }
  if (kind === 'ask') return message.answered
    ? { label: 'Answered', detail: 'A substantive answer is in the thread', tone: 'done' as const }
    : message.delivered_at || delivered > 0
      ? { label: 'Open', detail: 'Delivered; answer pending', tone: 'open' as const }
      : { label: 'Queued', detail: 'Waiting for the recipient', tone: 'pending' as const }
  if (kind === 'task') return message.delivered_at || delivered > 0
    ? { label: 'Delivered', detail: 'Action requested; no acknowledgment needed', tone: 'pending' as const }
    : { label: 'Queued', detail: 'Waiting for the recipient', tone: 'pending' as const }
  return message.delivered_at || delivered > 0
    ? { label: 'Delivered', detail: 'Returned to the original sender', tone: 'done' as const }
    : { label: 'Recorded', detail: 'Saved in this thread', tone: 'quiet' as const }
}

export function threadMatches(thread: Thread, filter: MessageFilter) {
  const kind = messageKind(thread)
  if (filter === 'all') return true
  if (filter === 'open') return kind === 'ask' && !thread.answered
  if (filter === 'questions') return kind === 'ask'
  if (filter === 'updates') return kind === 'notify' || kind === 'announce'
  return kind === 'task' || kind === 'swarm'
}

export const availableAgents = (agents: Agent[]) => agents.filter((agent) => agent.status !== 'gone')
export const swarmRecipientCount = (agents: Agent[]) =>
  agents.filter((agent) => agent.status !== 'gone' && agent.status !== 'paused_limit').length

// --- inbox (email-style Messages tab) ---

export type Mailbox = 'inbox' | 'needs_reply' | 'sent'

export const MAILBOXES: { key: Mailbox; label: string }[] = [
  { key: 'inbox', label: 'Inbox' },
  { key: 'needs_reply', label: 'Needs reply' },
  { key: 'sent', label: 'Sent' },
]

export type MailType = 'question' | 'action' | 'update' | 'blocker' | 'fyi'

export const MAIL_TYPE_META: Record<MailType, { label: string; tone: 'open' | 'pending' | 'quiet' | 'done' }> = {
  question: { label: 'Question', tone: 'open' },
  action: { label: 'Action required', tone: 'pending' },
  blocker: { label: 'Blocker', tone: 'pending' },
  update: { label: 'Update', tone: 'quiet' },
  fyi: { label: 'FYI', tone: 'quiet' },
}

export const mailType = (message: Pick<BoardMessage, 'mail_type'> & { kind?: BoardMessage['kind'] }): MailType => {
  if (message.mail_type && message.mail_type in MAIL_TYPE_META) return message.mail_type as MailType
  // a bare `orchestra ask human` carries no mail_type — it is a question by nature
  return messageKind(message) === 'ask' ? 'question' : 'update'
}

// a mail expecting something back stays in the queue until you answer it
export const mailExpectsReply = (message: Pick<BoardMessage, 'mail_type'> & { kind?: BoardMessage['kind'] }) => {
  const type = mailType(message)
  return type === 'question' || type === 'action' || type === 'blocker'
}

export type MailAttachment = { type: 'file' | 'card' | 'commit' | 'url'; ref: string }

export function parseAttachments(message: Pick<BoardMessage, 'attachments'>): MailAttachment[] {
  if (!message.attachments) return []
  try {
    const parsed = JSON.parse(message.attachments)
    return Array.isArray(parsed)
      ? parsed.filter((a) => a && typeof a.ref === 'string' && ['file', 'card', 'commit', 'url'].includes(a.type))
      : []
  } catch { return [] }
}

export const subjectOf = (thread: Pick<BoardMessage, 'subject' | 'body'>) =>
  thread.subject?.trim() || splitSubject(thread.body).subject

// email convention: first line of the body is the subject, the rest previews
export function splitSubject(body: string): { subject: string; snippet: string } {
  const text = body.replace(/\r\n/g, '\n').trim()
  const nl = text.indexOf('\n')
  const first = (nl === -1 ? text : text.slice(0, nl)).trim()
  const rest = nl === -1 ? '' : text.slice(nl + 1).replace(/\s+/g, ' ').trim()
  if (first.length <= 120) return { subject: first || '(no subject)', snippet: rest }
  return {
    subject: `${first.slice(0, 119).trimEnd()}…`,
    snippet: [`…${first.slice(119).trimStart()}`, rest].filter(Boolean).join(' '),
  }
}

// inbox = mail explicitly addressed to the operator; sent = you wrote the root.
// Agent↔agent traffic and broadcasts are board coordination — they never show here.
export function mailboxOf(thread: Thread): 'inbox' | 'sent' | 'board' {
  if (!thread.from_name) return 'sent'
  if (thread.to_human) return 'inbox'
  return 'board'
}

// mail stays in your queue until *you* answer, not until anyone replies
export const answeredByYou = (thread: Thread) => thread.replies.some((reply) => !reply.from_name)

export function inboxMatches(thread: Thread, mailbox: Mailbox): boolean {
  const box = mailboxOf(thread)
  if (mailbox === 'inbox') return box === 'inbox'
  if (mailbox === 'sent') return box === 'sent'
  return box === 'inbox' && mailExpectsReply(thread) && !answeredByYou(thread)
}

export const latestMessage = (thread: Thread): BoardMessage =>
  thread.replies.length > 0 ? thread.replies[thread.replies.length - 1] : thread

// newest message id written by an agent — the watermark that makes a thread unread
export const latestForeignId = (thread: Thread) => Math.max(
  thread.from_name ? thread.id : 0,
  ...thread.replies.filter((reply) => reply.from_name).map((reply) => reply.id),
)

export type ReadMap = Record<string, number>
const READ_KEY = 'orchestra-inbox-read-v1'
export const threadReadKey = (boardId: number, threadId: number) => `${boardId}:${threadId}`

export function loadReadMap(): ReadMap {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(READ_KEY) ?? '{}')
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch { return {} }
}

export function saveReadMap(map: ReadMap) {
  try { window.localStorage.setItem(READ_KEY, JSON.stringify(map)) } catch { /* private mode */ }
}

export const isUnread = (thread: Thread, boardId: number, map: ReadMap) =>
  latestForeignId(thread) > (map[threadReadKey(boardId, thread.id)] ?? 0)

export function buildMessagePayload(input: {
  boardId: number
  kind: ComposeKind
  body: string
  to?: string
  cardId?: number | null
  confirm?: boolean
}) {
  const body = input.body.trim()
  if (!body) throw new Error('Write a message first.')
  const meta = MESSAGE_KIND_META[input.kind]
  if (meta.needsTarget && !input.to) throw new Error(`${meta.label} needs one recipient.`)
  const payload: Record<string, unknown> = { board_id: input.boardId, kind: input.kind, body }
  if (meta.needsTarget) payload.to = input.to
  if (input.cardId) payload.card_id = input.cardId
  if (input.kind === 'swarm') payload.confirm = input.confirm === true
  return payload
}
