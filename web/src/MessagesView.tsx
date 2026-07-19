import React, { useEffect, useMemo, useState } from 'react'
import { Snapshot, Thread } from './api'
import { MessageComposer } from './MessageComposer'
import { MessageThread } from './MessageThread'
import { MessageFilter, threadMatches } from './messageUi'

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
}

const FILTERS: { key: MessageFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'open', label: 'Open' },
  { key: 'questions', label: 'Questions' },
  { key: 'updates', label: 'Updates' },
  { key: 'actions', label: 'Actions' },
]

export function MessagesView({ snaps, focused = false, onChange }: Props) {
  const [filter, setFilter] = useState<MessageFilter>('all')
  const [composeBoard, setComposeBoard] = useState<number>(() => snaps[0]?.board.id ?? 0)

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
    }))
  }).sort((a, b) => b.thread.id - a.thread.id), [snaps])

  const visible = rows.filter((row) => threadMatches(row.thread, filter))
  const openCount = rows.filter((row) => threadMatches(row.thread, 'open')).length
  const selected = snaps.find((snap) => snap.board.id === composeBoard) ?? snaps[0]

  return (
    <main className={`message-workspace ${focused ? 'focused' : ''}`}>
      <section className="message-inbox" aria-label="Messages">
        <header className="message-view-head">
          <div>
            <p className="message-view-kicker">Coordination</p>
            <h2>Messages</h2>
            <p>Every wake is explicit. Delivery state comes from receipts, not acknowledgment replies.</p>
          </div>
          <dl className="message-summary">
            <div><dt>Open</dt><dd>{openCount}</dd></div>
            <div><dt>Total</dt><dd>{rows.length}</dd></div>
          </dl>
        </header>

        <nav className="message-filters" aria-label="Filter messages">
          {FILTERS.map((item) => {
            const count = rows.filter((row) => threadMatches(row.thread, item.key)).length
            return (
              <button key={item.key} type="button" className={filter === item.key ? 'active' : ''}
                aria-pressed={filter === item.key} onClick={() => setFilter(item.key)}>
                {item.label}<span>{count}</span>
              </button>
            )
          })}
        </nav>

        <div className="message-feed" aria-live="polite">
          {visible.map((row) => (
            <MessageThread key={`${row.boardId}-${row.thread.id}`} thread={row.thread}
              boardLabel={snaps.length > 1 ? row.boardName : undefined}
              cardTitle={row.cardTitle} onChange={onChange} />
          ))}
          {visible.length === 0 && (
            <div className="message-empty">
              <h3>{filter === 'open' ? 'No unanswered questions' : 'No messages in this view'}</h3>
              <p>{filter === 'open'
                ? 'Questions disappear from this queue as soon as an answer is recorded.'
                : 'Choose an intent in the composer to start a precise coordination thread.'}</p>
            </div>
          )}
        </div>
      </section>

      <aside className="message-compose-panel" aria-label="Compose message">
        <div className="message-compose-heading">
          <p className="message-view-kicker">New message</p>
          <h3>Choose the wake behavior</h3>
        </div>
        {snaps.length > 1 && (
          <label className="message-field message-project-field">
            <span>Project</span>
            <select value={composeBoard} onChange={(event) => setComposeBoard(Number(event.target.value))}>
              {snaps.map((snap) => <option key={snap.board.id} value={snap.board.id}>{snap.board.name}</option>)}
            </select>
          </label>
        )}
        {selected ? (
          <MessageComposer key={selected.board.id} boardId={selected.board.id}
            agents={selected.agents} cards={selected.cards} onSent={onChange} />
        ) : (
          <p className="message-empty-inline">No project is available.</p>
        )}
      </aside>
    </main>
  )
}
