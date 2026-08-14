import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  knowledgeApi,
  type KnowledgeAction,
  type KnowledgeGraphifySync,
  type KnowledgeItem,
  type KnowledgeManifestEntry,
  type KnowledgePromotion,
  type KnowledgeReview,
} from './knowledgeApi'
import './knowledge.css'

type Loadable<T> = { data: T; loading: boolean; error: string | null }
const empty = <T,>(data: T): Loadable<T> => ({ data, loading: true, error: null })
const message = (error: unknown): string => error instanceof Error ? error.message : 'Knowledge could not be loaded.'

type WikiEntry = { item: KnowledgeItem; subject: string; group: string }

function subjectOf(item: KnowledgeItem): string {
  const first = (item.content.split('\n').find((line) => line.trim().length > 0) ?? '').trim()
  if (/^#{1,6}\s/.test(first)) return first.replace(/^#{1,6}\s+/, '')
  const dash = first.indexOf(' — ')
  if (dash > 0 && dash < 80) return first.slice(0, dash)
  if (first.length === 0) return item.citation.title
  return first.length > 64 ? `${first.slice(0, 61)}…` : first
}

function groupOf(item: KnowledgeItem): string {
  const { locator, source_kind, title } = item.citation
  if (locator.endsWith('GRAPH_REPORT.md')) return 'Architecture report'
  if (locator.endsWith('graph.json')) return 'Decisions & rationale'
  if (source_kind === 'readme' || source_kind === 'documentation') return title
  return source_kind.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())
}

/** README first, then docs alphabetically, graph-derived groups at the end. */
function groupWeight(name: string, entries: WikiEntry[]): number {
  if (entries[0]?.item.citation.source_kind === 'readme') return 0
  if (name === 'Architecture report') return 2
  if (name === 'Decisions & rationale') return 3
  return 1
}

/** Tiny markdown-ish renderer: headings, bullet lists, paragraphs, [[wikilinks]]. */
function renderArticle(content: string): ReactNode[] {
  const plain = (line: string) => line
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
  const nodes: ReactNode[] = []
  let list: string[] = []
  let paragraph: string[] = []
  const flush = () => {
    if (list.length) { nodes.push(<ul key={nodes.length}>{list.map((li, i) => <li key={i}>{li}</li>)}</ul>); list = [] }
    if (paragraph.length) { nodes.push(<p key={nodes.length}>{paragraph.join(' ')}</p>); paragraph = [] }
  }
  for (const raw of content.split('\n')) {
    const line = raw.trimEnd()
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) { flush(); nodes.push(<h4 key={nodes.length}>{plain(heading[2])}</h4>); continue }
    if (/^[-*]\s+/.test(line.trim())) { if (paragraph.length) flush(); list.push(plain(line.trim().replace(/^[-*]\s+/, ''))); continue }
    if (line.trim() === '') { flush(); continue }
    if (list.length) flush()
    paragraph.push(plain(line.trim()))
  }
  flush()
  return nodes
}

export function KnowledgeView({ boardId }: { boardId: number }) {
  const [items, setItems] = useState<Loadable<KnowledgeItem[]>>(empty([]))
  const [reviews, setReviews] = useState<Loadable<KnowledgeReview[]>>(empty([]))
  const [promotions, setPromotions] = useState<Loadable<KnowledgePromotion[]>>(empty([]))
  const [query, setQuery] = useState('')
  const [includeStale, setIncludeStale] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [reason, setReason] = useState('')
  const [replacement, setReplacement] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [syncOutcome, setSyncOutcome] = useState<string | null>(null)

  const load = async () => {
    setItems((current) => ({ ...current, loading: true, error: null }))
    const [knowledge, pending, promotionQueue] = await Promise.allSettled([
      knowledgeApi.browse(boardId, { query, includeStale, limit: 400 }),
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

  const entries = useMemo<WikiEntry[]>(
    () => items.data.map((item) => ({ item, subject: subjectOf(item), group: groupOf(item) })),
    [items.data],
  )
  const groups = useMemo(() => {
    const names = [...new Set(entries.map((entry) => entry.group))]
    const byName = new Map(names.map((name) => [name, entries.filter((entry) => entry.group === name)]))
    names.sort((left, right) =>
      groupWeight(left, byName.get(left) ?? []) - groupWeight(right, byName.get(right) ?? [])
      || left.localeCompare(right))
    return names.map((name) => ({ name, entries: byName.get(name) ?? [] }))
  }, [entries])
  const selected = useMemo(
    () => entries.find((entry) => entry.item.citation.chunk_id === selectedId) ?? entries[0] ?? null,
    [entries, selectedId],
  )

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
      await knowledgeApi.control(boardId, selected.item.citation.source_id, {
        action,
        reason: reason.trim(),
        replacementSourceId: replacement.trim() || undefined,
        pinned: action === 'pin' ? !selected.item.citation.pinned : undefined,
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

  const syncGraph = async () => {
    setBusy('graphify')
    setSyncOutcome(null)
    try {
      const sync: KnowledgeGraphifySync | null = await knowledgeApi.syncGraphify(boardId)
      setSyncOutcome(sync === null
        ? 'Graph sync finished without a result.'
        : sync.hint
          ?? `Graph synced: ${sync.created_sources} new, ${sync.unchanged_sources} unchanged, `
          + `${sync.superseded_sources} superseded source(s), ${sync.created_chunks} chunk(s).`)
      await load()
    } catch (error) {
      setSyncOutcome(message(error))
    } finally { setBusy(null) }
  }

  const citation = selected?.item.citation ?? null
  const range = citation === null || citation.start_line === null
    ? ''
    : `:${citation.start_line}${citation.end_line === citation.start_line ? '' : `–${citation.end_line}`}`

  return (
    <main className="knowledge-view">
      <header className="knowledge-hero">
        <div><p>Project wiki</p><h2>Wiki</h2>
          <span>Cited sources, explicit freshness, reviewable human control.</span></div>
        <div className="knowledge-hero-actions">
          <button onClick={() => void syncGraph()} disabled={busy === 'graphify'}>
            {busy === 'graphify' ? 'Syncing…' : 'Sync project graph'}</button>
          <button onClick={async () => { setBusy('refresh'); try { await knowledgeApi.refresh(boardId); await load() } finally { setBusy(null) } }}
            disabled={busy === 'refresh'}>{busy === 'refresh' ? 'Checking…' : 'Check repository freshness'}</button>
        </div>
      </header>
      {syncOutcome && <p className="knowledge-empty knowledge-sync-outcome">{syncOutcome}</p>}

      <form className="knowledge-search" onSubmit={(event) => { event.preventDefault(); void load() }}>
        <label><span>Search the wiki</span><input value={query} onChange={(event) => setQuery(event.target.value)}
          placeholder="Architecture, decisions, files, delivery evidence…" /></label>
        <button>Search</button>
        <label className="knowledge-check"><input type="checkbox" checked={includeStale}
          onChange={(event) => setIncludeStale(event.target.checked)} />Include stale and contradicted</label>
      </form>

      <section className="knowledge-wiki">
        <nav className="knowledge-index" aria-busy={items.loading} aria-label="Wiki subjects">
          <header><h3>Subjects</h3><span>{entries.length}</span></header>
          {items.error && <p className="knowledge-error">{items.error}</p>}
          {groups.map((group) => {
            const holdsSelection = group.entries.some(
              (entry) => entry.item.citation.chunk_id === selected?.item.citation.chunk_id)
            return <details className="knowledge-index-group" key={group.name}
              open={holdsSelection || groups.length <= 4}>
              <summary>{group.name}<span>{group.entries.length}</span></summary>
              {group.entries.map((entry) => <button type="button" key={entry.item.citation.chunk_id}
                className={selected?.item.citation.chunk_id === entry.item.citation.chunk_id ? 'active' : ''}
                onClick={() => setSelectedId(entry.item.citation.chunk_id)}>{entry.subject}</button>)}
            </details>
          })}
          {!items.loading && entries.length === 0 && <p className="knowledge-empty">No subjects yet.</p>}
        </nav>

        <div className="knowledge-reader">
          {pendingReviews.map((review) => <article className="knowledge-queue" key={review.id}>
            <b>{review.kind}</b><strong>{review.title}</strong><code>{review.normalized_locator}</code>
            <span>{review.freshness_reason.replace(/_/g, ' ')}</span>
          </article>)}
          {pendingPromotions.map((promotion) => <article className="knowledge-queue promotion" key={promotion.id}>
            <b>promotion</b><strong>{promotion.kind.replace(/_/g, ' ')}</strong>
            <span>Requested by {promotion.requested_by}. Exact source evidence is revalidated on approval.</span>
            <div><input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Review reason" />
              <button disabled={busy !== null || !reason.trim()} onClick={() => void decidePromotion(promotion, 'promote')}>Promote</button>
              <button disabled={busy !== null || !reason.trim()} onClick={() => void decidePromotion(promotion, 'reject')}>Reject</button></div>
          </article>)}

          {selected && citation ? <article className="knowledge-article">
            <header>
              <h3>{selected.subject}</h3>
              <div className="knowledge-meta">
                <span>{citation.source_kind.replace(/_/g, ' ')}</span>
                <b data-freshness={citation.freshness}>{citation.freshness}</b>
                {citation.pinned && <em>pinned</em>}
                <code>{citation.locator}{range}</code>
                <span>{citation.estimated_tokens.toLocaleString()} tok</span>
              </div>
            </header>
            <div className="knowledge-article-body">{renderArticle(selected.item.content)}</div>
            <footer>
              <small>revision {citation.source_revision.slice(0, 12)} · source {citation.source_content_sha256.slice(0, 12)} · {citation.title}</small>
              <details className="knowledge-curate">
                <summary>Curate this source</summary>
                <label><span>Review reason</span><textarea value={reason} onChange={(event) => setReason(event.target.value)}
                  placeholder="Record the evidence and rationale for this action." /></label>
                <label><span>Replacement source ID <small>edit / supersede</small></span>
                  <input value={replacement} onChange={(event) => setReplacement(event.target.value)} placeholder="ks_…" /></label>
                <div className="knowledge-actions">
                  {(['accept', 'edit', 'pin', 'reject', 'supersede', 'forget'] as KnowledgeAction[]).map((action) =>
                    <button key={action} onClick={() => void act(action)} disabled={busy !== null || !reason.trim()}>{action}</button>)}
                </div>
              </details>
            </footer>
          </article> : !items.loading && <div className="knowledge-empty knowledge-article">
            <p>This wiki is empty.</p>
            <p>To populate it from your project knowledge graph, run <code>/graphify .</code> (or <code>npx graphify analyze .</code>) in the repository, commit <code>graphify-out/</code>, then press “Sync project graph” above. Verified deliveries and promoted decisions also land here automatically.</p>
            <p>Agents can query this wiki over the API: <code>GET /api/v1/os/boards/{boardId}/knowledge?q=…</code></p>
          </div>}
        </div>
      </section>
    </main>
  )
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
