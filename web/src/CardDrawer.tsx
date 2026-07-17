import React, { useEffect, useState } from 'react'
import { api, Agent, Card } from './api'

export function CardDrawer({ card, boardId, agents, onClose, onChange }:
  { card: Card; boardId: number; agents: Agent[]; onClose: () => void; onChange: () => void }) {
  const [events, setEvents] = useState<any[]>([])
  const [comment, setComment] = useState('')
  useEffect(() => { api('GET', `/cards/${card.id}/events`).then(setEvents) }, [card.id])

  const send = async () => {
    if (!comment) return
    await api('POST', '/messages', { board_id: boardId, to: card.owner ?? undefined, card_id: card.id, body: comment })
    setComment(''); onChange()
  }

  return (
    <div className="drawer">
      <button className="close" onClick={onClose}>×</button>
      <h2>#{card.id} {card.title}</h2>
      <p><b>{card.owner ?? 'unowned'}</b> · {card.column} · updated {card.updated_at}</p>
      {card.description && <p>{card.description}</p>}
      {card.paths.length > 0 && <p><code>{card.paths.join(', ')}</code></p>}
      <h3>Activity</h3>
      <ul>{events.map((e) => <li key={e.id}><small>{e.created_at}</small> {e.agent ?? 'human'} {e.type}</li>)}</ul>
      <h3>Message {card.owner ?? 'owner'}</h3>
      <textarea value={comment} onChange={(e) => setComment(e.target.value)} />
      <button onClick={send}>Send</button>
    </div>
  )
}
