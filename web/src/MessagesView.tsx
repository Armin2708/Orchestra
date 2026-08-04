import React, { useEffect, useMemo, useState } from 'react'
import { api, ApiError, agentInk, agentWash, initials, BoardMessage, Snapshot, Thread, timeAgo } from './api'
import { MessageBody } from './MessageBody'
import { MessageComposer } from './MessageComposer'
import {
  answeredByYou,
  inboxMatches,
  isUnread,
  latestForeignId,
  latestMessage,
  loadReadMap,
  Mailbox,
  MAILBOXES,
  mailboxOf,
  MailAttachment,
  mailExpectsReply,
  MAIL_TYPE_META,
  mailType,
  parseAttachments,
  ReadMap,
  saveReadMap,
  splitSubject,
  subjectOf,
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

const mailDate = (sqlUtc: string) => {
  const date = new Date(sqlUtc.replace(' ', 'T') + 'Z')
  return date.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

function Avatar({ name }: { name: string }) {
  return (
    <span className="inbox-avatar" aria-hidden="true"
      style={{ background: agentWash(name), color: agentInk(name) }}>
      {initials(name)}
    </span>
  )
}

function TypeChip({ message }: { message: Pick<BoardMessage, 'mail_type' | 'kind'> }) {
  const type = mailType(message)
  const meta = MAIL_TYPE_META[type]
  return <span className={`mail-type-chip type-${type} tone-${meta.tone}`}>{meta.label}</span>
}

function AttachmentChip({ attachment, boardId, messageId, index }: {
  attachment: MailAttachment
  boardId: number
  messageId: number
  index: number
}) {
  const [open, setOpen] = useState(false)
  const [content, setContent] = useState<string | null>(null)
  const [error, setError] = useState('')

  if (attachment.type === 'card') {
    return (
      <a className="mail-attachment" href={`/?board=${boardId}&card=${attachment.ref}`}>
        <span className="mail-attachment-kind">card</span>#{attachment.ref}
      </a>
    )
  }
  if (attachment.type === 'url') {
    return (
      <a className="mail-attachment" href={attachment.ref} target="_blank" rel="noreferrer">
        <span className="mail-attachment-kind">link</span>{attachment.ref.replace(/^https?:\/\//, '').slice(0, 48)}
      </a>
    )
  }
  if (attachment.type === 'commit') {
    return (
      <span className="mail-attachment" title={attachment.ref}>
        <span className="mail-attachment-kind">commit</span><code>{attachment.ref.slice(0, 10)}</code>
      </span>
    )
  }

  const toggle = async () => {
    if (open) { setOpen(false); return }
    setOpen(true)
    setError('')
    if (content === null) {
      try {
        const result = await api('GET', `/messages/${messageId}/attachments/${index}`)
        setContent(result.content)
      } catch (err) {
        setError(readableError(err))
      }
    }
  }

  return (
    <span className="mail-attachment-file">
      <button type="button" className={`mail-attachment ${open ? 'open' : ''}`} onClick={toggle}
        aria-expanded={open} title={attachment.ref}>
        <span className="mail-attachment-kind">file</span>{attachment.ref.split('/').pop()}
      </button>
      {open && (
        <div className="mail-attachment-preview">
          <div className="mail-attachment-path">{attachment.ref}</div>
          {error ? <p className="message-form-state error" role="alert">{error}</p>
            : content === null ? <p className="mail-attachment-loading">Loading…</p>
              : <pre tabIndex={0}>{content}</pre>}
        </div>
      )}
    </span>
  )
}

function MailBody({ message, boardId, cardTitles }: {
  message: BoardMessage
  boardId: number
  cardTitles: ReadonlyMap<number, string>
}) {
  // structured mail renders as a plain letter — full text, paragraphs kept;
  // legacy protocol messages keep the annotated view with the raw escape hatch
  if (message.subject) return <div className="mail-letter">{message.body}</div>
  return <MessageBody message={message} boardId={boardId} cardTitles={cardTitles} />
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
  const subject = subjectOf(thread)
  const sender = thread.from_name ?? 'You'
  const attachments = parseAttachments(thread)
  const canReply = Boolean(thread.from_name) || thread.replies.some((item) => item.from_name)
  const needsAnswer = mailboxOf(thread) === 'inbox' && mailExpectsReply(thread) && !answeredByYou(thread)

  useEffect(() => { setReply(''); setError('') }, [row.boardId, thread.id])

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
    if (!window.confirm('Delete this mail and its replies?')) return
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
    <article className="inbox-reading" aria-label={`Mail: ${subject}`}>
      <header className="inbox-reading-head">
        <button className="inbox-back" type="button" onClick={onBack}>
          <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M12.5 4.5 7 10l5.5 5.5" /></svg>
          <span>Inbox</span>
        </button>
        <div className="inbox-reading-title">
          <h2>{subject}</h2>
          <div className="inbox-reading-meta">
            <TypeChip message={thread} />
            <span className="inbox-reading-route">
              <b>{sender}</b> to {thread.from_name ? 'You' : thread.to_name ?? 'agents'}
            </span>
            <time dateTime={thread.created_at} title={thread.created_at}>{mailDate(thread.created_at)}</time>
            <span className="inbox-reading-board">{row.boardName}</span>
            {thread.card_id && (
              <a className="message-card-label" href={`/?board=${thread.board_id}&card=${thread.card_id}`}>
                Card #{thread.card_id}{row.cardTitle ? ` · ${row.cardTitle}` : ''}
              </a>
            )}
          </div>
        </div>
        <button className="message-delete" type="button" aria-label="Delete mail"
          title="Delete mail" disabled={busy} onClick={remove}>
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="M6.4 7.2v7.1m3.6-7.1v7.1m3.6-7.1v7.1M4.6 4.8h10.8m-7-2h3.2m-5.8 2 .6 11.9h7.2l.6-11.9" />
          </svg>
        </button>
      </header>

      <div className="inbox-mail-scroll">
        {attachments.length > 0 && (
          <div className="mail-attachments" aria-label={`${attachments.length} attachments`}>
            {attachments.map((attachment, index) => (
              <AttachmentChip key={`${attachment.type}-${attachment.ref}-${index}`} attachment={attachment}
                boardId={thread.board_id} messageId={thread.id} index={index} />
            ))}
          </div>
        )}

        <div className="mail-body-block">
          <MailBody message={thread} boardId={thread.board_id} cardTitles={row.cardTitles} />
        </div>

        {thread.replies.length > 0 && (
          <ol className="mail-replies" aria-label={`${thread.replies.length} replies`}>
            {thread.replies.map((message) => {
              const author = message.from_name ?? 'You'
              return (
                <li key={message.id} className={message.from_name ? 'from-agent' : 'from-you'}>
                  <Avatar name={author} />
                  <div className="inbox-message">
                    <div className="inbox-message-meta">
                      <b>{author}</b>
                      <time dateTime={message.created_at}>{timeAgo(message.created_at)}</time>
                    </div>
                    <div className="mail-letter">{message.body}</div>
                  </div>
                </li>
              )
            })}
          </ol>
        )}
      </div>

      {error && <p className="message-form-state error" role="alert">{error}</p>}
      {canReply ? (
        <form className="inbox-reply" onSubmit={send}>
          <label>
            <span>{needsAnswer ? 'Answer' : 'Reply'} to {sender}</span>
            <textarea rows={3} value={reply} placeholder="Your reply is delivered straight to the agent…"
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
  const unreadTotal = rows.filter((row) => mailboxOf(row.thread) !== 'board' && isUnread(row.thread, row.boardId, readMap)).length

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

  // a reply landing in the open mail is read the moment it renders
  useEffect(() => { if (selected) markRead(selected) }, [selected && latestForeignId(selected.thread), selectedKey])

  const open = (row: ThreadRow) => {
    setComposing(false)
    setSelectedKey(rowKey(row))
    markRead(row)
  }

  const composeSnap = snaps.find((snap) => snap.board.id === composeBoard) ?? snaps[0]

  return (
    <main className={`inbox-workspace ${focused ? 'focused' : ''} ${selected || composing ? 'detail-open' : ''}`}>
      <section className="inbox-list" aria-label="Mail list">
        <header className="inbox-head">
          <div>
            <h2>Inbox</h2>
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
            const subject = subjectOf(row.thread)
            const sender = row.thread.from_name ?? 'You'
            const attachmentCount = parseAttachments(row.thread).length
            const preview = row.thread.replies.length > 0
              ? `${last.from_name ?? 'You'}: ${splitSubject(last.body).subject}`
              : row.thread.subject ? splitSubject(row.thread.body).subject : splitSubject(row.thread.body).snippet
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
                    <TypeChip message={row.thread} />
                    {attachmentCount > 0 && (
                      <span className="inbox-row-attachments" title={`${attachmentCount} attachments`}>
                        <svg viewBox="0 0 20 20" aria-hidden="true">
                          <path d="M14.5 8.6 9.9 13.2a2.6 2.6 0 0 1-3.7-3.7l5.3-5.3a1.8 1.8 0 0 1 2.5 2.5l-5.2 5.2a.9.9 0 0 1-1.3-1.3l4.6-4.6" />
                        </svg>
                        {attachmentCount}
                      </span>
                    )}
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
              <h3>{mailbox === 'needs_reply' ? 'Nothing waiting on you'
                : mailbox === 'inbox' ? 'Inbox zero'
                  : 'Nothing sent yet'}</h3>
              <p>{mailbox === 'sent'
                ? 'Compose a message to reach an agent directly.'
                : 'Agents mail you with orchestra mail — subject, context, and attached docs land here.'}</p>
            </div>
          )}
        </div>
      </section>

      <section className="inbox-detail" aria-label="Mail">
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
            <h3>Select a mail</h3>
            <p>Agents write you real emails — subject, full context, docs attached. Your reply goes straight back.</p>
          </div>
        )}
      </section>
    </main>
  )
}
