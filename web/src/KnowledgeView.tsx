import { useEffect, useMemo, useState } from 'react'
import {
  knowledgeApi,
  type KnowledgeAction,
  type KnowledgeItem,
  type KnowledgeManifestEntry,
  type KnowledgePromotion,
  type KnowledgeReview,
} from './knowledgeApi'
import './knowledge.css'

type Loadable<T> = { data: T; loading: boolean; error: string | null }
const empty = <T,>(data: T): Loadable<T> => ({ data, loading: true, error: null })
const message = (error: unknown): string => error instanceof Error ? error.message : 'Knowledge could not be loaded.'

export function KnowledgeView({ boardId }: { boardId: number }) {
  const [items, setItems] = useState<Loadable<KnowledgeItem[]>>(empty([]))
  const [reviews, setReviews] = useState<Loadable<KnowledgeReview[]>>(empty([]))
  const [promotions, setPromotions] = useState<Loadable<KnowledgePromotion[]>>(empty([]))
  const [query, setQuery] = useState('')
  const [includeStale, setIncludeStale] = useState(false)
  const [selected, setSelected] = useState<KnowledgeItem | null>(null)
  const [reason, setReason] = useState('')
  const [replacement, setReplacement] = useState('')
  const [busy, setBusy] = useState<string | null>(null)

  const load = async () => {
    setItems((current) => ({ ...current, loading: true, error: null }))
    const [knowledge, pending, promotionQueue] = await Promise.allSettled([
      knowledgeApi.browse(boardId, { query, includeStale, limit: 50 }),
      knowledgeApi.reviews(boardId),
      knowledgeApi.promotions(boardId),
    ])
    setItems(knowledge.status === 'fulfilled'
      ? { data: knowledge.value, loading: false, error: null }
      : { data: [], loading: false, error: message(knowledge.reason) })
    setReviews(pending.status === 'fulfilled'
      ? { data: pending.value, loading: false, error: null }
      : { data: [], loading: false, error: message(pending.reason) })
    setPromotions(promotionQueue.status === 'fulfilled'
      ? { data: promotionQueue.value, loading: false, error: null }
      : { data: [], loading: false, error: message(promotionQueue.reason) })
  }

  useEffect(() => { void load() }, [boardId, includeStale])

  const pendingReviews = useMemo(
    () => reviews.data.filter((review) => review.status === 'pending'),
    [reviews.data],
  )
  const pendingPromotions = useMemo(
    () => promotions.data.filter((promotion) => promotion.status === 'pending'),
    [promotions.data],
  )

  const act = async (action: KnowledgeAction) => {
    if (!selected || !reason.trim()) return
    if ((action === 'edit' || action === 'supersede') && !replacement.trim()) return
    setBusy(action)
    try {
      await knowledgeApi.control(boardId, selected.citation.source_id, {
        action,
        reason: reason.trim(),
        replacementSourceId: replacement.trim() || undefined,
        pinned: action === 'pin' ? !selected.citation.pinned : undefined,
      })
      setReason('')
      setReplacement('')
      await load()
    } finally { setBusy(null) }
  }

  const decidePromotion = async (promotion: KnowledgePromotion, decision: 'promote' | 'reject') => {
    if (!reason.trim()) return
    setBusy(`${promotion.id}:${decision}`)
    try {
      await knowledgeApi.reviewPromotion(boardId, promotion.id, decision, reason.trim())
      setReason('')
      await load()
    } finally { setBusy(null) }
  }

  return (
    <main className="knowledge-view">
      <header className="knowledge-hero">
        <div><p>Repository intelligence</p><h2>Knowledge</h2>
          <span>Cited sources, explicit freshness, reviewable human control.</span></div>
        <button onClick={async () => { setBusy('refresh'); try { await knowledgeApi.refresh(boardId); await load() } finally { setBusy(null) } }}
          disabled={busy === 'refresh'}>{busy === 'refresh' ? 'Checking…' : 'Check repository freshness'}</button>
      </header>

      <form className="knowledge-search" onSubmit={(event) => { event.preventDefault(); void load() }}>
        <label><span>Search knowledge</span><input value={query} onChange={(event) => setQuery(event.target.value)}
          placeholder="Files, decisions, symbols, delivery evidence…" /></label>
        <button>Search</button>
        <label className="knowledge-check"><input type="checkbox" checked={includeStale}
          onChange={(event) => setIncludeStale(event.target.checked)} />Include stale and contradicted</label>
      </form>

      <section className="knowledge-layout">
        <div className="knowledge-results" aria-busy={items.loading}>
          <header><h3>Browse</h3><span>{items.data.length} cited chunks</span></header>
          {items.error && <p className="knowledge-error">{items.error}</p>}
          {!items.loading && items.data.length === 0 && <p className="knowledge-empty">No fresh knowledge matches this view.</p>}
          {items.data.map((item) => <KnowledgeCard key={item.citation.chunk_id} item={item}
            active={selected?.citation.chunk_id === item.citation.chunk_id} onSelect={() => setSelected(item)} />)}
        </div>

        <aside className="knowledge-review-panel">
          <header><p>Human review</p><h3>{pendingReviews.length + pendingPromotions.length} need attention</h3></header>
          {selected ? <>
            <div className="knowledge-selected"><span>Selected source</span><strong>{selected.citation.title}</strong>
              <code>{selected.citation.source_id.slice(0, 18)}…</code></div>
            <label><span>Review reason</span><textarea value={reason} onChange={(event) => setReason(event.target.value)}
              placeholder="Record the evidence and rationale for this action." /></label>
            <label><span>Replacement source ID <small>edit / supersede</small></span>
              <input value={replacement} onChange={(event) => setReplacement(event.target.value)} placeholder="ks_…" /></label>
            <div className="knowledge-actions">
              {(['accept', 'edit', 'pin', 'reject', 'supersede', 'forget'] as KnowledgeAction[]).map((action) =>
                <button key={action} onClick={() => void act(action)} disabled={busy !== null || !reason.trim()}>{action}</button>)}
            </div>
          </> : <p className="knowledge-empty">Select a source to accept, edit by replacement, pin, reject, supersede, or forget it.</p>}

          {pendingReviews.map((review) => <article className="knowledge-queue" key={review.id}>
            <b>{review.kind}</b><strong>{review.title}</strong><code>{review.normalized_locator}</code>
            <span>{review.freshness_reason.replaceAll('_', ' ')}</span>
          </article>)}
          {pendingPromotions.map((promotion) => <article className="knowledge-queue promotion" key={promotion.id}>
            <b>promotion</b><strong>{promotion.kind.replaceAll('_', ' ')}</strong>
            <span>Requested by {promotion.requested_by}. Exact source evidence is revalidated on approval.</span>
            <div><button disabled={busy !== null || !reason.trim()} onClick={() => void decidePromotion(promotion, 'promote')}>Promote</button>
              <button disabled={busy !== null || !reason.trim()} onClick={() => void decidePromotion(promotion, 'reject')}>Reject</button></div>
          </article>)}
        </aside>
      </section>
    </main>
  )
}

function KnowledgeCard({ item, active, onSelect }: { item: KnowledgeItem; active: boolean; onSelect: () => void }) {
  const citation = item.citation
  const range = citation.start_line === null ? '' : `:${citation.start_line}${citation.end_line === citation.start_line ? '' : `–${citation.end_line}`}`
  return <button type="button" className={`knowledge-card ${active ? 'active' : ''}`} onClick={onSelect}>
    <header><span>{citation.source_kind.replaceAll('_', ' ')}</span>
      <b data-freshness={citation.freshness}>{citation.freshness}</b>{citation.pinned && <em>pinned</em>}</header>
    <h4>{citation.title}</h4><p>{item.content}</p>
    <footer><code>{citation.locator}{range}</code><span>{citation.estimated_tokens.toLocaleString()} tok</span></footer>
    <small>revision {citation.source_revision} · source {citation.source_content_sha256.slice(0, 12)}</small>
  </button>
}

export function KnowledgeContextManifest({ entries }: { entries: KnowledgeManifestEntry[] }) {
  const selected = entries.filter((entry) => entry.selected)
  const tokens = selected.reduce((total, entry) => total + entry.estimated_tokens, 0)
  return <section className="knowledge-manifest">
    <header><div><p>Compiled context</p><h3>Why included</h3></div><strong>{tokens.toLocaleString()} attributable tokens</strong></header>
    {entries.map((entry) => <article key={entry.chunk_id} className={entry.selected ? '' : 'omitted'}>
      <div><strong>{entry.citation.title}</strong><code>{entry.citation.locator}</code></div>
      <p>{entry.why_included}</p>
      <span>{entry.estimated_tokens.toLocaleString()} tok · {entry.token_contribution_percent.toFixed(2)}%</span>
    </article>)}
  </section>
}
