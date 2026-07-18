import React, { useEffect, useRef, useState } from 'react'
import { api, Agent, Card, ReviewDecision, agentInk, agentWash, initials, timeAgo } from './api'
import { STATUS } from './Board'

const EVENT_VERB: Record<string, string> = {
  created: 'created the card', updated: 'updated the card', moved: 'moved the card', comment: 'commented',
  review_request: 'parked it for review', review_decision: 'recorded a review decision',
}

export function CardDrawer({ card, boardId, agents = [], onClose, onChange }:
  { card: Card; boardId: number; agents?: Agent[]; onClose: () => void; onChange: () => void }) {
  const [events, setEvents] = useState<any[]>([])
  const [comment, setComment] = useState('')
  const [editingDesc, setEditingDesc] = useState(false)
  const [desc, setDesc] = useState(card.description)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [reviews, setReviews] = useState<ReviewDecision[]>([])
  const [reviewNote, setReviewNote] = useState('')

  useEffect(() => { api('GET', `/cards/${card.id}/events`).then(setEvents) }, [card.id, card.updated_at])
  useEffect(() => { api('GET', `/cards/${card.id}/reviews`).then(setReviews).catch(() => {}) }, [card.id, card.updated_at])
  useEffect(() => { setDesc(card.description) }, [card.description])

  // modal behavior: take focus on open, close on Escape
  const panelRef = useRef<HTMLElement>(null)
  useEffect(() => { panelRef.current?.focus() }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const send = async () => {
    if (!comment.trim()) return
    await api('POST', '/messages', { board_id: boardId, to: card.owner ?? undefined, card_id: card.id, body: comment.trim() })
    setComment(''); onChange()
  }
  const saveDesc = async () => {
    await api('PATCH', `/cards/${card.id}`, { description: desc })
    setEditingDesc(false); onChange()
  }
  const latestRequest = [...events].reverse().find((e) => e.type === 'review_request')
  let reviewReq: { summary?: string; diffstat?: string } | null = null
  try { reviewReq = latestRequest ? JSON.parse(latestRequest.payload) : null } catch { /* legacy payload */ }
  const approve = async () => {
    await api('POST', `/cards/${card.id}/approve`, reviewNote.trim() ? { note: reviewNote.trim() } : {})
    setReviewNote(''); onChange()
  }
  const sendBack = async () => {
    if (!reviewNote.trim()) return
    await api('POST', `/cards/${card.id}/send-back`, { note: reviewNote.trim() })
    setReviewNote(''); onChange()
  }

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer" ref={panelRef} tabIndex={-1}
        role="dialog" aria-modal="true" aria-label={`Card #${card.id} — ${card.title}`}>
        <button className="close" onClick={onClose} aria-label="Close">×</button>
        <p className="drawer-kicker">Card #{card.id}</p>
        <h2>{card.title}</h2>
        <div className="status-row">
          {Object.entries(STATUS).map(([key, st]) => (
            <button key={key}
              className={`status-chip pick ${card.column === key ? 'active' : ''}`}
              style={card.column === key ? { background: st.bg, color: st.ink } : undefined}
              onClick={async () => { await api('POST', `/cards/${card.id}/move`, { column: key }); onChange() }}>
              {st.label}
            </button>
          ))}
        </div>
        <p className="drawer-owner">
          {card.owner
            ? <><i className="avatar mini" style={{ background: agentWash(card.owner), color: agentInk(card.owner) }}>{initials(card.owner)}</i> {card.owner}</>
            : 'unassigned'} · updated {timeAgo(card.updated_at)}
          {agents.length > 0 && (
            <select className="assign-select" defaultValue="" title="Assign this ticket — the agent gets briefed and starts"
              onChange={async (e) => {
                if (!e.target.value) return
                await api('POST', `/cards/${card.id}/assign`, { agent: e.target.value })
                e.target.value = ''; onChange()
              }}>
              <option value="" disabled>assign…</option>
              {agents.filter((a) => a.name !== card.owner).map((a) => <option key={a.id} value={a.name}>{a.name}</option>)}
            </select>
          )}
          {!card.owner && card.column !== 'done' && (
            <button className="thread-reply" title="Spawn a fresh autonomous agent on this ticket"
              onClick={async () => {
                try { await api('POST', `/cards/${card.id}/launch`) } catch { /* daemon-only or already launched */ }
                onChange()
              }}>▶ Launch agent</button>
          )}
        </p>

        {card.column === 'review' && (
          <section className="review-panel">
            <h3>Needs your review</h3>
            {reviewReq?.summary && <p className="review-summary">{reviewReq.summary}</p>}
            {reviewReq?.diffstat && <pre className="review-diffstat">{reviewReq.diffstat}</pre>}
            <textarea className="review-note" rows={2} value={reviewNote}
              placeholder="Note for the agent — optional on approve, required to send back"
              onChange={(e) => setReviewNote(e.target.value)} />
            <div className="review-actions">
              <button className="btn primary review-approve" onClick={approve}>Approve</button>
              <button className="btn ghost review-sendback" disabled={!reviewNote.trim()} onClick={sendBack}>Send back</button>
            </div>
          </section>
        )}
        {reviews.length > 0 && (
          <>
            <h3>Review history</h3>
            <ol className="review-history">
              {reviews.map((d) => (
                <li key={d.id} className={d.decision === 'approve' ? 'approved' : 'sent-back'}>
                  <b>{d.decision === 'approve' ? '✓ Approved' : '↩ Sent back'}</b>
                  {d.note && <span className="review-hist-note"> — {d.note}</span>}
                  <time> {timeAgo(d.decided_at)}</time>
                </li>
              ))}
            </ol>
          </>
        )}

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
              <i className="tl-dot" style={{ background: e.agent ? agentInk(e.agent) : '#c9c5bc' }} />
              <span><b>{e.agent ?? 'you'}</b> {EVENT_VERB[e.type] ?? e.type} <time>{timeAgo(e.created_at)}</time></span>
            </li>
          ))}
          {events.length === 0 && <li className="tl-empty">No activity yet</li>}
        </ol>

        <h3>Message {card.owner ?? 'the board'}</h3>
        <textarea value={comment} placeholder="Lands in the agent's context within seconds if it's working, or at its next turn"
          onChange={(e) => setComment(e.target.value)} />
        <button className="btn primary" onClick={send}>Send</button>

        <div className="drawer-footer">
          {card.column === 'done' && (
            <button className="btn primary" onClick={async () => {
              await api('POST', `/cards/${card.id}/restore`); onClose(); onChange()
            }}>↺ Restore to backlog</button>
          )}
          {confirmDelete ? (
            <>
              <button className="btn danger" onClick={async () => {
                await api('DELETE', `/cards/${card.id}`); onClose(); onChange()
              }}>Delete card permanently</button>
              <button className="btn ghost" onClick={() => setConfirmDelete(false)}>Keep it</button>
            </>
          ) : (
            <button className="btn ghost danger-text" onClick={() => setConfirmDelete(true)}>Delete card</button>
          )}
        </div>
      </aside>
    </>
  )
}
