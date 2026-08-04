import React, { useEffect, useMemo, useState } from 'react'
import { api, ApiError, agentInk, agentWash, initials, Snapshot, Thread, timeAgo } from './api'
import { MessageBody } from './MessageBody'
import { MessageComposer } from './MessageComposer'
import {
  inboxMatches,
  isUnread,
  latestForeignId,
  latestMessage,
  loadReadMap,
  Mailbox,
  MAILBOXES,
  mailboxOf,
  MESSAGE_KIND_META,
  messageKind,
  messageRoute,
  ReadMap,
  saveReadMap,
  splitSubject,
  threadReadKey,
} from './messageUi'

type Props = {
  snaps: Snapshot[]
  focused?: boolean
  onChange: () => void | Promise<void>
}

type ThreadRow = {
  thread: Thread
  boardId: number
  boardName: string
  cardTitle: string | null
  cardTitles: ReadonlyMap<number, string>
}

const readableError = (error: unknown) => {
  if (!(error instanceof Error)) return String(error)
  if (!(error instanceof ApiError)) return error.message
  try { return JSON.parse(error.message).error ?? error.message } catch { return error.message }
}

const rowKey = (row: ThreadRow) => `${row.boardId}-${row.thread.id}`

function Avatar({ name }: { name: string }) {
  return (
    <span className="inbox-avatar" aria-hidden="true"
      style={{ background: agentWash(name), color: agentInk(name) }}>
      {initials(name)}
    </span>
  )
}

function ReadingPane({ row, onChange, onBack, onDeleted }: {
  row: ThreadRow
  onChange: () => void | Promise<void>
  onBack: () => void
  onDeleted: () => void
}) {
  const { thread } = row
  const [reply, setReply] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const kind = messageKind(thread)
  const meta = MESSAGE_KIND_META[kind]
  const route = messageRoute(thread)
  const { subject } = splitSubject(thread.body)
  // someone must be on the other end — the server routes a reply to the root sender,
  // or to the latest agent participant when the root is yours
  const canReply = Boolean(thread.from_name) || thread.replies.some((item) => item.from_name)
  const needsAnswer = mailboxOf(thread) === 'inbox' && kind === 'ask' && !thread.replies.some((item) => !item.from_name)

  useEffect(() => { setReply(''); setError('') }, [row.boardId, thread.id])

  const conversation = [thread, ...thread.replies]

  const send = async (event: React.FormEvent) => {
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
      await onChange()
    } catch (err) {
      setError(readableError(err))
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!window.confirm('Delete this conversation and its replies?')) return
    setBusy(true)
    try {
      await api('DELETE', `/messages/${thread.id}`)
      onDeleted()
      await onChange()
    } catch (err) {
      setError(readableError(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <article className="inbox-reading" aria-label={`Conversation: ${subject}`}>
      <header className="inbox-reading-head">
        <button className="inbox-back" type="button" onClick={onBack}>
          <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M12.5 4.5 7 10l5.5 5.5" /></svg>
          <span>Inbox</span>
        </button>
        <div className="inbox-reading-title">
          <h2>{subject}</h2>
          <div className="inbox-reading-meta">
            <span className={`message-kind-badge kind-${kind}`}>{meta.label}</span>
            <span className="inbox-reading-route">{route.from} → {route.to}</span>
            <span className="inbox-reading-board">{row.boardName}</span>
            {thread.card_id && (
              <a className="message-card-label" href={`/?board=${thread.board_id}&card=${thread.card_id}`}>
                Card #{thread.card_id}{row.cardTitle ? ` · ${row.cardTitle}` : ''}
              </a>
            )}
          </div>
        </div>
        <button className="message-delete" type="button" aria-label="Delete conversation"
          title="Delete conversation" disabled={busy} onClick={remove}>
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="M6.4 7.2v7.1m3.6-7.1v7.1m3.6-7.1v7.1M4.6 4.8h10.8m-7-2h3.2m-5.8 2 .6 11.9h7.2l.6-11.9" />
          </svg>
        </button>
      </header>

      <ol className="inbox-conversation" aria-label={`${conversation.length} messages`}>
        {conversation.map((message) => {
          const author = message.from_name ?? 'You'
          return (
            <li key={message.id} className={message.from_name ? 'from-agent' : 'from-you'}>
              <Avatar name={author} />
              <div className="inbox-message">
                <div className="inbox-message-meta">
                  <b>{author}</b>
                  <time dateTime={message.created_at}>{timeAgo(message.created_at)}</time>
                </div>
                <MessageBody message={message} boardId={thread.board_id} cardTitles={row.cardTitles} />
              </div>
            </li>
          )
        })}
      </ol>

      {error && <p className="message-form-state error" role="alert">{error}</p>}
      {canReply ? (
        <form className="inbox-reply" onSubmit={send}>
          <label>
            <span>{needsAnswer ? 'Answer this question' : 'Reply'}</span>
            <textarea rows={3} value={reply} placeholder="Write a reply — it is delivered straight to the agent…"
              onChange={(event) => { setReply(event.target.value); setError('') }}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') send(event)
              }} />
          </label>
          <div className="inbox-reply-actions">
            <span className="inbox-reply-hint">⌘↵ to send</span>
            <button className="btn primary" type="submit" disabled={busy || !reply.trim()}>
              {busy ? 'Sending…' : needsAnswer ? 'Send answer' : 'Send reply'}
            </button>
          </div>
        </form>
      ) : (
        <p className="inbox-reply-disabled">No agent is on this thread yet — replies would reach no one.</p>
      )}
    </article>
  )
}

export function MessagesView({ snaps, focused = false, onChange }: Props) {
  const [mailbox, setMailbox] = useState<Mailbox>('inbox')
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [composing, setComposing] = useState(false)
  const [composeBoard, setComposeBoard] = useState<number>(() => snaps[0]?.board.id ?? 0)
  const [readMap, setReadMap] = useState<ReadMap>(() => loadReadMap())

  useEffect(() => {
    if (!snaps.some((snap) => snap.board.id === composeBoard)) setComposeBoard(snaps[0]?.board.id ?? 0)
  }, [composeBoard, snaps])

  const rows = useMemo<ThreadRow[]>(() => snaps.flatMap((snap) => {
    const cards = new Map(snap.cards.map((card) => [card.id, card.title]))
    return snap.threads.map((thread) => ({
      thread,
      boardId: snap.board.id,
      boardName: snap.board.name,
      cardTitle: thread.card_id ? cards.get(thread.card_id) ?? null : null,
      cardTitles: cards,
    }))
  }).sort((a, b) => latestMessage(b.thread).id - latestMessage(a.thread).id), [snaps])

  const visible = rows.filter((row) => inboxMatches(row.thread, mailbox))
  const selected = selectedKey ? rows.find((row) => rowKey(row) === selectedKey) ?? null : null
  const unreadTotal = rows.filter((row) => mailboxOf(row.thread) !== 'sent' && isUnread(row.thread, row.boardId, readMap)).length

  const markRead = (row: ThreadRow) => {
    const watermark = latestForeignId(row.thread)
    const key = threadReadKey(row.boardId, row.thread.id)
    setReadMap((current) => {
      if ((current[key] ?? 0) >= watermark) return current
      const next = { ...current, [key]: watermark }
      saveReadMap(next)
      return next
    })
  }

  // a reply landing in the open conversation is read the moment it renders
  useEffect(() => { if (selected) markRead(selected) }, [selected && latestForeignId(selected.thread), selectedKey])

  const open = (row: ThreadRow) => {
    setComposing(false)
    setSelectedKey(rowKey(row))
    markRead(row)
  }

  const composeSnap = snaps.find((snap) => snap.board.id === composeBoard) ?? snaps[0]

  return (
    <main className={`inbox-workspace ${focused ? 'focused' : ''} ${selected || composing ? 'detail-open' : ''}`}>
      <section className="inbox-list" aria-label="Message list">
        <header className="inbox-head">
          <div>
            <h2>Messages</h2>
            <p className="inbox-unread-total">{unreadTotal === 0 ? 'All caught up' : `${unreadTotal} unread`}</p>
          </div>
          <button className="btn primary inbox-compose-btn" type="button"
            onClick={() => { setComposing(true); setSelectedKey(null) }}>
            Compose
          </button>
        </header>

        <nav className="inbox-tabs" aria-label="Mailboxes">
          {MAILBOXES.map((item) => {
            const count = item.key === 'inbox'
              ? rows.filter((row) => inboxMatches(row.thread, 'inbox') && isUnread(row.thread, row.boardId, readMap)).length
              : rows.filter((row) => inboxMatches(row.thread, item.key)).length
            return (
              <button key={item.key} type="button" className={mailbox === item.key ? 'active' : ''}
                aria-pressed={mailbox === item.key} onClick={() => setMailbox(item.key)}>
                {item.label}{count > 0 && <span>{count}</span>}
              </button>
            )
          })}
        </nav>

        <div className="inbox-rows" role="list" aria-live="polite">
          {visible.map((row) => {
            const unread = isUnread(row.thread, row.boardId, readMap)
            const last = latestMessage(row.thread)
            const { subject, snippet } = splitSubject(row.thread.body)
            const sender = row.thread.from_name ?? 'You'
            const preview = row.thread.replies.length > 0
              ? `${last.from_name ?? 'You'}: ${splitSubject(last.body).subject}`
              : snippet
            return (
              <button key={rowKey(row)} type="button" role="listitem"
                className={`inbox-row ${unread ? 'unread' : ''} ${selectedKey === rowKey(row) ? 'active' : ''}`}
                onClick={() => open(row)}>
                {unread && <span className="inbox-unread-dot" aria-label="Unread" />}
                <Avatar name={sender} />
                <span className="inbox-row-main">
                  <span className="inbox-row-top">
                    <b>{sender}</b>
                    <time dateTime={last.created_at}>{timeAgo(last.created_at)}</time>
                  </span>
                  <span className="inbox-row-subject">{subject}</span>
                  {preview && <span className="inbox-row-snippet">{preview}</span>}
                  <span className="inbox-row-tags">
                    <span className={`message-kind-badge kind-${messageKind(row.thread)}`}>
                      {MESSAGE_KIND_META[messageKind(row.thread)].label}
                    </span>
                    {snaps.length > 1 && <span className="message-board-label">{row.boardName}</span>}
                    {row.thread.card_id && <span className="inbox-row-card">#{row.thread.card_id}</span>}
                    {row.thread.replies.length > 0 && (
                      <span className="inbox-row-count">{row.thread.replies.length + 1}</span>
                    )}
                  </span>
                </span>
              </button>
            )
          })}
          {visible.length === 0 && (
            <div className="message-empty">
              <h3>{mailbox === 'needs_reply' ? 'No questions waiting on you'
                : mailbox === 'inbox' ? 'Inbox zero'
                  : mailbox === 'sent' ? 'Nothing sent yet' : 'No messages'}</h3>
              <p>{mailbox === 'sent'
                ? 'Compose a message to reach an agent directly.'
                : 'Agents reach you here with orchestra ask human — questions wait until you answer.'}</p>
            </div>
          )}
        </div>
      </section>

      <section className="inbox-detail" aria-label="Conversation">
        {composing ? (
          <div className="inbox-compose">
            <header className="inbox-reading-head">
              <button className="inbox-back" type="button" onClick={() => setComposing(false)}>
                <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M12.5 4.5 7 10l5.5 5.5" /></svg>
                <span>Inbox</span>
              </button>
              <div className="inbox-reading-title"><h2>New message</h2></div>
            </header>
            {snaps.length > 1 && (
              <label className="message-field message-project-field">
                <span>Project</span>
                <select value={composeBoard} onChange={(event) => setComposeBoard(Number(event.target.value))}>
                  {snaps.map((snap) => <option key={snap.board.id} value={snap.board.id}>{snap.board.name}</option>)}
                </select>
              </label>
            )}
            {composeSnap ? (
              <MessageComposer key={composeSnap.board.id} boardId={composeSnap.board.id}
                agents={composeSnap.agents} cards={composeSnap.cards} onSent={onChange} />
            ) : (
              <p className="message-empty-inline">No project is available.</p>
            )}
          </div>
        ) : selected ? (
          <ReadingPane row={selected} onChange={onChange}
            onBack={() => setSelectedKey(null)} onDeleted={() => setSelectedKey(null)} />
        ) : (
          <div className="inbox-placeholder" aria-hidden="true">
            <h3>Select a conversation</h3>
            <p>Messages from working agents land here. Your reply goes straight back to the agent.</p>
          </div>
        )}
      </section>
    </main>
  )
}
