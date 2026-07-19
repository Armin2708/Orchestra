import React, { useEffect, useMemo, useState } from 'react'
import { api, ApiError, Agent, Card } from './api'
import {
  availableAgents,
  buildMessagePayload,
  COMPOSE_KINDS,
  ComposeKind,
  MESSAGE_KIND_META,
  swarmRecipientCount,
} from './messageUi'

type Props = {
  boardId: number
  agents: Agent[]
  cards?: Card[]
  fixedCardId?: number
  defaultTo?: string | null
  defaultKind?: ComposeKind
  compact?: boolean
  onSent: () => void | Promise<void>
}

const errorMessage = (error: unknown) => {
  if (!(error instanceof Error)) return String(error)
  if (!(error instanceof ApiError)) return error.message
  try { return JSON.parse(error.message).error ?? error.message } catch { return error.message }
}

export function MessageComposer({
  boardId,
  agents,
  cards = [],
  fixedCardId,
  defaultTo = null,
  defaultKind = 'ask',
  compact = false,
  onSent,
}: Props) {
  const liveAgents = useMemo(() => availableAgents(agents), [agents])
  const [kind, setKind] = useState<ComposeKind>(defaultKind)
  const [to, setTo] = useState(defaultTo ?? '')
  const [cardId, setCardId] = useState<number | null>(fixedCardId ?? null)
  const [body, setBody] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const [sent, setSent] = useState('')
  const [swarmArmed, setSwarmArmed] = useState(false)
  const meta = MESSAGE_KIND_META[kind]
  const swarmCount = swarmRecipientCount(agents)

  useEffect(() => {
    setCardId(fixedCardId ?? null)
    setError('')
    setSent('')
    setSwarmArmed(false)
  }, [boardId, fixedCardId])

  useEffect(() => {
    if (!meta.needsTarget) return
    if (to && liveAgents.some((agent) => agent.name === to)) return
    const preferred = defaultTo && liveAgents.some((agent) => agent.name === defaultTo) ? defaultTo : liveAgents[0]?.name
    setTo(preferred ?? '')
  }, [defaultTo, liveAgents, meta.needsTarget, to])

  const chooseKind = (next: ComposeKind) => {
    setKind(next)
    setError('')
    setSent('')
    setSwarmArmed(false)
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setError('')
    setSent('')
    if (kind === 'swarm' && !swarmArmed) {
      if (!body.trim()) { setError('Write the swarm task first.'); return }
      setSwarmArmed(true)
      return
    }
    setSending(true)
    try {
      const payload = buildMessagePayload({
        boardId,
        kind,
        body,
        to,
        cardId: fixedCardId ?? cardId,
        confirm: kind === 'swarm' && swarmArmed,
      })
      const result = await api('POST', '/messages', payload)
      const recipients = Number(result.recipient_count ?? 0)
      const delivered = Number(result.delivered_count ?? 0)
      setSent(kind === 'announce'
        ? 'Posted to board history. No agents were woken.'
        : kind === 'notify'
          ? 'Queued for the agent\'s next natural turn.'
          : kind === 'swarm'
            ? `Sent to ${recipients} snapshotted agent${recipients === 1 ? '' : 's'}; ${delivered} delivered now.`
            : delivered > 0 ? 'Delivered.' : 'Queued for delivery.')
      setBody('')
      setSwarmArmed(false)
      await onSent()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setSending(false)
    }
  }

  const disabled = sending || !body.trim() || (meta.needsTarget && !to)

  return (
    <form className={`message-composer ${compact ? 'compact' : ''}`} onSubmit={submit}>
      <fieldset className="message-kind-picker">
        <legend>Intent</legend>
        <div className="message-kind-options">
          {COMPOSE_KINDS.map((option) => (
            <button key={option} type="button" className={`message-kind-option kind-${option} ${kind === option ? 'active' : ''}`}
              aria-pressed={kind === option} onClick={() => chooseKind(option)}>
              {MESSAGE_KIND_META[option].label}
            </button>
          ))}
        </div>
      </fieldset>

      <div className={`message-intent-note tone-${meta.tone}`}>
        <b>{meta.wakes}</b>
        <span>{meta.hint}</span>
      </div>

      <div className="message-compose-fields">
        {meta.needsTarget && (
          <label className="message-field">
            <span>Recipient</span>
            <select value={to} onChange={(event) => { setTo(event.target.value); setError('') }}>
              {liveAgents.length === 0 && <option value="">No agents available</option>}
              {liveAgents.map((agent) => (
                <option key={agent.id} value={agent.name}>{agent.name} · {agent.status}</option>
              ))}
            </select>
          </label>
        )}

        {!fixedCardId && cards.length > 0 && (
          <label className="message-field">
            <span>Card context <small>optional</small></span>
            <select value={cardId ?? ''} onChange={(event) => setCardId(event.target.value ? Number(event.target.value) : null)}>
              <option value="">No card</option>
              {cards.map((card) => <option key={card.id} value={card.id}>#{card.id} {card.title}</option>)}
            </select>
          </label>
        )}

        <label className="message-field message-body-field">
          <span>{kind === 'ask' ? 'Question' : kind === 'task' || kind === 'swarm' ? 'Work' : 'Message'}</span>
          <textarea value={body} rows={compact ? 3 : 5}
            placeholder={kind === 'ask' ? 'Ask one precise question…'
              : kind === 'task' ? 'Describe the action and expected result…'
                : kind === 'notify' ? 'Share context for the next natural turn…'
                  : kind === 'announce' ? 'Post an update without waking agents…'
                    : 'Describe the work that needs several agents…'}
            onChange={(event) => { setBody(event.target.value); setError(''); setSent(''); setSwarmArmed(false) }} />
        </label>
      </div>

      {kind === 'swarm' && swarmArmed && (
        <div className="swarm-confirm" role="alert">
          <b>Confirm fan-out to {swarmCount} available agent{swarmCount === 1 ? '' : 's'}.</b>
          <span>The recipient list is snapshotted once. Agents joining later will not receive it.</span>
        </div>
      )}
      {error && <p className="message-form-state error" role="alert">{error}</p>}
      {sent && <p className="message-form-state success" role="status">{sent}</p>}

      <div className="message-compose-actions">
        <button className={`btn primary ${kind === 'swarm' && swarmArmed ? 'confirm-swarm' : ''}`} type="submit" disabled={disabled}>
          {sending ? 'Sending…' : kind === 'swarm' && swarmArmed ? `Confirm and wake ${swarmCount}` : meta.action}
        </button>
        {kind === 'swarm' && swarmArmed && (
          <button className="btn ghost" type="button" onClick={() => setSwarmArmed(false)}>Cancel</button>
        )}
      </div>
    </form>
  )
}
