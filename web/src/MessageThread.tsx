import React, { useState } from 'react'
import { api, ApiError, Thread, timeAgo } from './api'
import { MessageBody } from './MessageBody'
import { deliverySummary, MESSAGE_KIND_META, messageKind, messageRoute } from './messageUi'

type Props = {
  thread: Thread
  boardLabel?: string
  cardTitle?: string | null
  cardTitles?: ReadonlyMap<number, string>
  compact?: boolean
  onChange: () => void | Promise<void>
}

const readableError = (error: unknown) => {
  if (!(error instanceof Error)) return String(error)
  if (!(error instanceof ApiError)) return error.message
  try { return JSON.parse(error.message).error ?? error.message } catch { return error.message }
}

export function MessageThread({ thread, boardLabel, cardTitle, cardTitles, compact = false, onChange }: Props) {
  const [replying, setReplying] = useState(false)
  const [reply, setReply] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const kind = messageKind(thread)
  const meta = MESSAGE_KIND_META[kind]
  const route = messageRoute(thread)
  const delivery = deliverySummary(thread)
  const canReply = Boolean(thread.from_name)

  const sendReply = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!reply.trim()) return
    setBusy(true)
    setError('')
    try {
      await api('POST', '/messages', {
        board_id: thread.board_id,
        card_id: thread.card_id ?? undefined,
        kind: 'reply',
        reply_to: thread.id,
        body: reply.trim(),
      })
      setReply('')
      setReplying(false)
      await onChange()
    } catch (err) {
      setError(readableError(err))
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!window.confirm(`Delete this ${meta.label.toLowerCase()} and its answers?`)) return
    setBusy(true)
    try {
      await api('DELETE', `/messages/${thread.id}`)
      await onChange()
    } catch (err) {
      setError(readableError(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <article className={`message-thread kind-${kind} ${compact ? 'compact' : ''}`}>
      <header className="message-thread-head">
        <div className="message-thread-meta">
          <span className={`message-kind-badge kind-${kind}`}>{meta.label}</span>
          {boardLabel && <span className="message-board-label">{boardLabel}</span>}
          {thread.card_id && (
            <a className="message-card-label" href={`/?board=${thread.board_id}&card=${thread.card_id}`}>
              Card #{thread.card_id}{cardTitle ? ` · ${cardTitle}` : ''}
            </a>
          )}
        </div>
        <button className="message-delete" type="button" aria-label={`Delete ${meta.label.toLowerCase()}`}
          title="Delete thread" disabled={busy} onClick={remove}>×</button>
      </header>

      <div className="message-route">
        <b>{route.from}</b><span aria-hidden="true">→</span><b>{route.to}</b>
        <time>{timeAgo(thread.created_at)}</time>
      </div>
      <MessageBody message={thread} boardId={thread.board_id} cardTitles={cardTitles} />

      <div className="message-delivery-row">
        <span className={`message-delivery tone-${delivery.tone}`}>{delivery.label}</span>
        <span>{delivery.detail}</span>
      </div>

      {thread.replies.length > 0 && (
        <ol className="message-answers" aria-label="Answers">
          {thread.replies.map((answer) => (
            <li key={answer.id}>
              <div className="message-answer-meta">
                <b>{answer.from_name ?? 'You'}</b>
                <span>Answer</span>
                <time>{timeAgo(answer.created_at)}</time>
              </div>
              <MessageBody message={answer} boardId={thread.board_id} cardTitles={cardTitles} />
            </li>
          ))}
        </ol>
      )}

      {error && <p className="message-form-state error" role="alert">{error}</p>}
      {replying ? (
        <form className="message-answer-form" onSubmit={sendReply}>
          <label>
            <span>{kind === 'ask' && !thread.answered ? 'Answer this question' : 'Continue the thread'}</span>
            <textarea autoFocus rows={3} value={reply} onChange={(event) => { setReply(event.target.value); setError('') }} />
          </label>
          <div>
            <button className="btn primary" type="submit" disabled={busy || !reply.trim()}>{busy ? 'Sending…' : 'Send answer'}</button>
            <button className="btn ghost" type="button" onClick={() => { setReplying(false); setReply(''); setError('') }}>Cancel</button>
          </div>
        </form>
      ) : canReply && (
        <button className="message-reply-action" type="button" onClick={() => setReplying(true)}>
          {kind === 'ask' && !thread.answered ? 'Answer question' : 'Reply'}
        </button>
      )}
    </article>
  )
}
