import React, { useEffect, useState } from 'react'
import { api, Card, agentColor, initials, timeAgo } from './api'

const EVENT_VERB: Record<string, string> = {
  created: 'created the card', updated: 'updated the card', moved: 'moved the card', comment: 'commented',
}

export function CardDrawer({ card, boardId, onClose, onChange }:
  { card: Card; boardId: number; onClose: () => void; onChange: () => void }) {
  const [events, setEvents] = useState<any[]>([])
  const [comment, setComment] = useState('')
  const [editingDesc, setEditingDesc] = useState(false)
  const [desc, setDesc] = useState(card.description)

  useEffect(() => { api('GET', `/cards/${card.id}/events`).then(setEvents) }, [card.id, card.updated_at])
  useEffect(() => { setDesc(card.description) }, [card.description])

  const send = async () => {
    if (!comment.trim()) return
    await api('POST', '/messages', { board_id: boardId, to: card.owner ?? undefined, card_id: card.id, body: comment.trim() })
    setComment(''); onChange()
  }
  const saveDesc = async () => {
    await api('PATCH', `/cards/${card.id}`, { description: desc })
    setEditingDesc(false); onChange()
  }

  const ownerColor = card.owner ? agentColor(card.owner) : 'hsl(40 8% 72%)'

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer" style={{ ['--owner' as any]: ownerColor }}>
        <div className="drawer-band" />
        <button className="close" onClick={onClose} aria-label="Close">×</button>
        <p className="drawer-kicker">card #{card.id} · {card.column.replace('_', ' ')}</p>
        <h2>{card.title}</h2>
        <p className="drawer-owner">
          {card.owner
            ? <><i className="avatar mini" style={{ background: ownerColor }}>{initials(card.owner)}</i> {card.owner}</>
            : 'unassigned'} · updated {timeAgo(card.updated_at)}
        </p>

        <h3>Scope</h3>
        {editingDesc ? (
          <div className="desc-edit">
            <textarea autoFocus value={desc} onChange={(e) => setDesc(e.target.value)} />
            <div className="row">
              <button className="btn primary" onClick={saveDesc}>Save</button>
              <button className="btn ghost" onClick={() => { setDesc(card.description); setEditingDesc(false) }}>Cancel</button>
            </div>
          </div>
        ) : (
          <p className="desc" onClick={() => setEditingDesc(true)} title="Click to edit">
            {card.description || 'No scope written yet — click to add one.'}
          </p>
        )}
        {card.paths.length > 0 && <div className="tags">{card.paths.map((p) => <code key={p}>{p}</code>)}</div>}

        <h3>Activity</h3>
        <ol className="timeline">
          {events.map((e) => (
            <li key={e.id}>
              <i className="tl-dot" style={{ background: e.agent ? agentColor(e.agent) : 'hsl(40 8% 72%)' }} />
              <span><b>{e.agent ?? 'you'}</b> {EVENT_VERB[e.type] ?? e.type} <time>{timeAgo(e.created_at)}</time></span>
            </li>
          ))}
          {events.length === 0 && <li className="tl-empty">No activity yet</li>}
        </ol>

        <h3>Message {card.owner ?? 'the board'}</h3>
        <textarea value={comment} placeholder="Lands in the agent's context within ~30s"
          onChange={(e) => setComment(e.target.value)} />
        <button className="btn primary" onClick={send}>Send</button>
      </aside>
    </>
  )
}
