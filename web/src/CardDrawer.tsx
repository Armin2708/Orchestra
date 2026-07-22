import React, { useEffect, useRef, useState } from 'react'
import { api, Agent, Card, ReviewDecision, Snapshot, Thread, agentInk, agentWash, initials, timeAgo } from './api'
import { STATUS } from './Board'
import { MessageComposer } from './MessageComposer'
import { MessageThread } from './MessageThread'
import { ProviderLaunchControl } from './ProviderLaunchControl'
import { CardTrackbookSummary } from './CardTrackbookSummary'
import type { AgentProviderCatalog } from './osApi'

const EVENT_VERB: Record<string, string> = {
  created: 'created the card', updated: 'updated the card', moved: 'moved the card', comment: 'commented',
  review_request: 'parked it for review', review_decision: 'recorded a review decision',
}

export const buildApprovalBody = (note: string): { note?: string; confirm: true } => {
  const trimmed = note.trim()
  return trimmed ? { note: trimmed, confirm: true } : { confirm: true }
}

const actionErrorText = (error: unknown, fallback: string) => {
  const message = error instanceof Error ? error.message : String(error ?? '')
  try {
    const parsed = JSON.parse(message) as { error?: unknown }
    if (typeof parsed.error === 'string' && parsed.error.trim()) return parsed.error
  } catch { /* plain-text API response */ }
  return message.trim() || fallback
}

export function CardDrawer({ card, boardId, agents = [], providers = [], onClose, onChange }:
  { card: Card; boardId: number; agents?: Agent[]; providers?: AgentProviderCatalog[]; onClose: () => void; onChange: () => void }) {
  const [events, setEvents] = useState<any[]>([])
  const [editingDesc, setEditingDesc] = useState(false)
  const [desc, setDesc] = useState(card.description)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [reviews, setReviews] = useState<ReviewDecision[]>([])
  const [reviewNote, setReviewNote] = useState('')
  const [reviewError, setReviewError] = useState<string | null>(null)
  const [approving, setApproving] = useState(false)
  const [conversation, setConversation] = useState<Thread[]>([])
  const [messageAgents, setMessageAgents] = useState<Agent[]>(agents)
  const [conversationLoading, setConversationLoading] = useState(true)

  useEffect(() => { api('GET', `/cards/${card.id}/events`).then(setEvents) }, [card.id, card.updated_at])
  useEffect(() => { api('GET', `/cards/${card.id}/reviews`).then(setReviews).catch(() => {}) }, [card.id, card.updated_at])
  useEffect(() => { setDesc(card.description) }, [card.description])
  useEffect(() => { setReviewError(null) }, [card.id])
  useEffect(() => {
    let current = true
    setConversationLoading(true)
    api('GET', `/boards/${boardId}/snapshot`).then((snap: Snapshot) => {
      if (!current) return
      setConversation(snap.threads.filter((thread) => thread.card_id === card.id))
      setMessageAgents(snap.agents.filter((agent) => agent.status !== 'gone'))
    }).catch(() => {
      if (current) setMessageAgents(agents)
    }).finally(() => { if (current) setConversationLoading(false) })
    return () => { current = false }
  }, [boardId, card.id])

  // modal behavior: take focus on open, close on Escape
  const panelRef = useRef<HTMLElement>(null)
  useEffect(() => { panelRef.current?.focus() }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const refreshConversation = async () => {
    const snap: Snapshot = await api('GET', `/boards/${boardId}/snapshot`)
    setConversation(snap.threads.filter((thread) => thread.card_id === card.id))
    setMessageAgents(snap.agents.filter((agent) => agent.status !== 'gone'))
    onChange()
  }
  const saveDesc = async () => {
    await api('PATCH', `/cards/${card.id}`, { description: desc })
    setEditingDesc(false); onChange()
  }
  const latestRequest = [...events].reverse().find((e) => e.type === 'review_request')
  let reviewReq: { summary?: string; diffstat?: string } | null = null
  try { reviewReq = latestRequest ? JSON.parse(latestRequest.payload) : null } catch { /* legacy payload */ }
  const verification = card.verification
  const approve = async () => {
    if (verification?.running) {
      setReviewError('Wait for the active verification to finish before approving.')
      return
    }
    // a failed verification demands an explicit confirm; the flag travels to the auto-ship gate
    const overridingFail = verification?.verdict === 'fail'
    if (overridingFail && !window.confirm(`The verifier marked this card FAIL. Approve anyway?`)) return
    setReviewError(null)
    setApproving(true)
    try {
      await api('POST', `/cards/${card.id}/approve`, buildApprovalBody(reviewNote))
      setReviewNote(''); onChange()
    } catch (error) {
      setReviewError(actionErrorText(error, 'Could not approve this delivery.'))
    } finally {
      setApproving(false)
    }
  }
  const runVerify = async () => {
    try { await api('POST', `/cards/${card.id}/verify`) } catch { /* already running or daemon-only */ }
    onChange()
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
            <ProviderLaunchControl providers={providers} variant="card" label="▶ Launch agent"
              title="Spawn a fresh autonomous agent on this ticket"
              onLaunch={async (body) => { await api('POST', `/cards/${card.id}/launch`, body); onChange() }} />
          )}
        </p>

        {card.column === 'review' && (
          <section className="review-panel">
            <h3>Needs your review</h3>
            {reviewReq?.summary && <p className="review-summary">{reviewReq.summary}</p>}
            {reviewReq?.diffstat && <pre className="review-diffstat">{reviewReq.diffstat}</pre>}
            <div className="verify-block">
              {verification?.running && <p className="verify-running">◌ verifier running…</p>}
              {!verification?.running && verification?.verdict && (
                <>
                  <p className={`verify-verdict v-${verification.verdict}`}>
                    {verification.verdict === 'pass' ? '✓ verified' : verification.verdict === 'gaps' ? '△ gaps found' : '✗ verification failed'}
                    {verification.tested ? ' · tests run' : ''}{verification.by ? ` · by ${verification.by}` : ''}
                  </p>
                  {(verification.criteria ?? []).length > 0 && (
                    <ul className="verify-criteria">
                      {verification.criteria!.map((c, i) => (
                        <li key={i} className={c.met === true ? 'crit-met' : c.met === false ? 'crit-unmet' : 'crit-unknown'}>
                          <span className="crit-mark">{c.met === true ? '✓' : c.met === false ? '✗' : '△'}</span>
                          <span className="crit-text">{c.text}</span>
                          {c.evidence && <span className="crit-evidence">{c.evidence}</span>}
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}
              {!verification?.running && (
                <button className="btn ghost verify-run" onClick={runVerify}>
                  {verification?.verdict ? '↻ Re-verify' : '◎ Verify delivery'}
                </button>
              )}
            </div>
            <textarea className="review-note" rows={2} value={reviewNote}
              placeholder="Note for the agent — optional on approve, required to send back"
              onChange={(e) => setReviewNote(e.target.value)} />
            {reviewError && <p className="review-error" role="alert">{reviewError}</p>}
            <div className="review-actions">
              <button className="btn primary review-approve" disabled={approving || verification?.running} onClick={approve}>{approving ? 'Approving…' : 'Approve'}</button>
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

        <CardTrackbookSummary card={card} boardId={boardId} onOpenFull={onClose} />

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

        <h3>Conversation</h3>
        <section className="card-conversation" aria-label={`Conversation for card ${card.id}`}>
          {conversationLoading && <p className="card-conversation-loading">Loading messages…</p>}
          {!conversationLoading && conversation.length === 0 && (
            <p className="card-conversation-empty">No card-linked messages yet. Choose an intent below to start one.</p>
          )}
          {conversation.length > 0 && (
            <div className="card-conversation-list">
              {conversation.map((thread) => (
                <MessageThread key={thread.id} thread={thread} compact onChange={refreshConversation} />
              ))}
            </div>
          )}
          <MessageComposer boardId={boardId} agents={messageAgents} fixedCardId={card.id}
            defaultTo={card.owner} defaultKind={card.owner ? 'notify' : 'announce'} compact
            onSent={refreshConversation} />
        </section>

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
