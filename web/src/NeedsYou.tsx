import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ApiError } from './api'
import { AttentionItem, osApi } from './osApi'
import { OsIcon } from './OsIcon'

type BoardRef = { id: number; name: string }

const severityOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 }

const relativeTime = (value: string) => {
  const normalized = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(normalized).getTime()) / 1000))
  if (seconds < 60) return 'now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`
  return `${Math.floor(seconds / 86400)}d`
}

export function NeedsYou({ boards, onOpen }: {
  boards: BoardRef[]
  onOpen?: (item: AttentionItem) => void
}) {
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<AttentionItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [resolving, setResolving] = useState<Set<string>>(new Set())
  const closeRef = useRef<HTMLButtonElement>(null)
  const boardsRef = useRef(boards)
  boardsRef.current = boards
  const boardKey = boards.map((board) => board.id).join(',')

  const load = useCallback(async (quiet = false) => {
    const current = boardsRef.current
    if (current.length === 0) { setItems([]); return }
    if (!quiet) setLoading(true)
    try {
      const groups = await Promise.all(current.map((board) => osApi.listAttention(board.id)))
      setItems(groups.flat().filter((item) => item.status === 'open').sort((a, b) => {
        const severity = (severityOrder[a.severity] ?? 5) - (severityOrder[b.severity] ?? 5)
        return severity || new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
      }))
      setError(null)
    } catch (loadError) {
      setError(loadError instanceof ApiError && loadError.status === 404
        ? 'Attention projection is not available on this daemon yet.'
        : loadError instanceof Error ? loadError.message : 'Needs You could not be loaded.')
    } finally {
      if (!quiet) setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
    const timer = window.setInterval(() => load(true), 12_000)
    return () => window.clearInterval(timer)
  }, [boardKey, load])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'a') {
        event.preventDefault()
        setOpen((current) => !current)
      }
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    if (open) window.requestAnimationFrame(() => closeRef.current?.focus())
  }, [open])

  const boardNames = useMemo(() => new Map(boards.map((board) => [board.id, board.name])), [boardKey])
  const urgent = items.filter((item) => item.severity === 'critical' || item.severity === 'high').length

  const resolve = async (item: AttentionItem) => {
    const id = String(item.id)
    setResolving((current) => new Set(current).add(id))
    try {
      await osApi.resolveAttention(item.id)
      setItems((current) => current.filter((candidate) => String(candidate.id) !== id))
      setError(null)
    } catch (resolveError) {
      setError(resolveError instanceof Error ? resolveError.message : 'The item could not be resolved.')
    } finally {
      setResolving((current) => {
        const next = new Set(current)
        next.delete(id)
        return next
      })
    }
  }

  return (
    <>
      <button className={`os-attention-trigger${urgent ? ' urgent' : ''}`} onClick={() => setOpen(true)}
        aria-haspopup="dialog" aria-expanded={open} aria-label={`Needs You, ${items.length} open items`}
        title="Needs You — Command/Control + Shift + A">
        <OsIcon name="attention" />
        <span>Needs You</span>
        {items.length > 0 && <span className="os-attention-count">{items.length}</span>}
      </button>

      {open && (
        <div className="os-attention-layer">
          <button className="os-attention-scrim" onClick={() => setOpen(false)} aria-label="Close Needs You" />
          <aside className="os-attention-drawer" role="dialog" aria-modal="true" aria-labelledby="needs-you-title">
            <header className="os-attention-head">
              <div>
                <p className="os-eyebrow">Human attention queue</p>
                <h2 id="needs-you-title">Needs You</h2>
                <p>Only decisions blocking useful work appear here.</p>
              </div>
              <button ref={closeRef} className="os-icon-button" onClick={() => setOpen(false)} aria-label="Close Needs You">
                <OsIcon name="close" />
              </button>
            </header>

            <div className="os-attention-tools">
              <span>{urgent > 0 ? `${urgent} urgent` : 'No urgent blockers'}</span>
              <button className="os-text-button" onClick={() => load()} disabled={loading}>
                <OsIcon name="refresh" /> Refresh
              </button>
            </div>

            {error && <div className="os-inline-error" role="alert">{error}</div>}

            <div className="os-attention-list">
              {loading && items.length === 0 && <AttentionSkeleton />}
              {!loading && items.length === 0 && !error && (
                <div className="os-empty-state compact">
                  <span className="os-empty-icon"><OsIcon name="check" size={20} /></span>
                  <h3>The fleet is moving</h3>
                  <p>Questions, permission requests, conflicts, and failed checks will collect here.</p>
                </div>
              )}
              {items.map((item) => {
                const busy = resolving.has(String(item.id))
                return (
                  <article className="os-attention-item" key={`${item.board_id}-${item.id}`}>
                    <div className="os-attention-line">
                      <span className={`os-severity ${item.severity}`}>{item.severity}</span>
                      <span className="os-attention-kind">{item.kind.split('_').join(' ')}</span>
                      <time>{relativeTime(item.created_at)}</time>
                    </div>
                    <h3>{item.title}</h3>
                    {item.detail && <p>{item.detail}</p>}
                    <footer>
                      <span>{boardNames.get(item.board_id) ?? `Project ${item.board_id}`}</span>
                      <div>
                        {item.workspace_id !== null && onOpen && (
                          <button className="os-text-button" onClick={() => { onOpen(item); setOpen(false) }}>
                            Open workspace <OsIcon name="external" size={13} />
                          </button>
                        )}
                        <button className="os-resolve-button" onClick={() => resolve(item)} disabled={busy}>
                          <OsIcon name="check" size={14} /> {busy ? 'Resolving' : 'Resolve'}
                        </button>
                      </div>
                    </footer>
                  </article>
                )
              })}
            </div>
          </aside>
        </div>
      )}
    </>
  )
}

function AttentionSkeleton() {
  return (
    <div className="os-attention-skeleton" aria-label="Loading attention items">
      {[0, 1, 2].map((item) => <div key={item}><i /><b /><span /></div>)}
    </div>
  )
}
