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
