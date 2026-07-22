import React, { useEffect, useMemo, useState } from 'react'
import { Card } from './api'
import { DeliveryCollection, DeliveryOutcome, DeliveryReport, osApi, OsId } from './osApi'
import { OsIcon } from './OsIcon'

const COMPLETE_STATUSES = new Set(['accepted', 'complete', 'completed', 'delivered', 'met', 'pass', 'passed', 'shipped', 'verified'])
const FAILED_STATUSES = new Set(['blocked', 'fail', 'failed', 'missed', 'rejected', 'unmet'])

type CompactSummary = {
  headline: string
  tone: 'complete' | 'attention' | 'failed' | 'empty'
  asked: string
  delivered: string
  complete: number
  total: number
  needsEvidence: number
  failed: number
}

type LoadState = {
  status: 'loading' | 'ready' | 'error'
  data: DeliveryCollection
  workspaceId: OsId | null
  error: string | null
}

const emptyDeliveries: DeliveryCollection = { deliveries: [], current: null }

const resultFor = (results: DeliveryOutcome[], id: string | null, index: number) => id
  ? results.find((result) => result.id === id) ?? null
  : results[index] ?? null

const isSupported = (result: DeliveryOutcome | null) => Boolean(result?.override || (result
  && COMPLETE_STATUSES.has(result.status)
  && result.gaps.length === 0
  && result.evidence.length > 0))

export const summarizeTrackbookDelivery = (delivery: DeliveryReport | null, card: Pick<Card, 'title' | 'description'>): CompactSummary => {
  const asked = delivery?.asked.objective || card.description || card.title
  if (!delivery) return {
    headline: 'No delivery has been submitted.', tone: 'empty', asked,
    delivered: 'Waiting for the first delivery report.', complete: 0, total: 0, needsEvidence: 0, failed: 0,
  }

  const matched = [
    ...delivery.asked.deliverables.map((promise, index) => ({ promise, result: resultFor(delivery.deliverable_results, promise.id, index) })),
    ...delivery.asked.acceptance_criteria.map((promise, index) => ({ promise, result: resultFor(delivery.criterion_results, promise.id, index) })),
  ].filter(({ promise }) => promise.required).map(({ result }) => result)
  const complete = matched.filter(isSupported).length
  const failed = matched.filter((result) => result && !result.override && FAILED_STATUSES.has(result.status)).length
  const needsEvidence = Math.max(0, matched.length - complete - failed)
  const parts = [`Delivered ${complete} of ${matched.length} required outcome${matched.length === 1 ? '' : 's'}`]
  if (needsEvidence) parts.push(`${needsEvidence} need${needsEvidence === 1 ? 's' : ''} evidence`)
  if (failed) parts.push(`${failed} failed`)
  const headline = matched.length
    ? `${parts.join('; ')}.`
    : 'Delivery submitted; no required outcomes are recorded.'
  return {
    headline,
    tone: failed ? 'failed' : needsEvidence || !matched.length ? 'attention' : 'complete',
    asked,
    delivered: delivery.human_summary || delivery.summary
      || delivery.delivered_items.map((item) => item.text).filter(Boolean).join('; ')
      || 'A report exists, but no delivered summary was supplied.',
    complete,
    total: matched.length,
    needsEvidence,
    failed,
  }
}

const errorText = (reason: unknown) => reason instanceof Error ? reason.message : 'Delivery reports could not be loaded.'

export function CardTrackbookSummary({ card, boardId, onOpenFull }: {
  card: Card
  boardId: number
  onOpenFull: () => void
}) {
  const [state, setState] = useState<LoadState>({ status: 'loading', data: emptyDeliveries, workspaceId: null, error: null })

  useEffect(() => {
    let current = true
    setState({ status: 'loading', data: emptyDeliveries, workspaceId: null, error: null })
    Promise.allSettled([osApi.getDeliveries(card.id), osApi.listWorkspaces(boardId)]).then(([deliveryResult, workspaceResult]) => {
      if (!current) return
      const workspaceId = workspaceResult.status === 'fulfilled'
        ? workspaceResult.value.find((workspace) => workspace.card_id === card.id)?.id ?? null : null
      if (deliveryResult.status === 'rejected') {
        setState({ status: 'error', data: emptyDeliveries, workspaceId, error: errorText(deliveryResult.reason) })
        return
      }
      const reportWorkspace = deliveryResult.value.current?.workspace_id ?? null
      setState({ status: 'ready', data: deliveryResult.value, workspaceId: reportWorkspace ?? workspaceId, error: null })
    })
    return () => { current = false }
  }, [boardId, card.id, card.updated_at])

  const delivery = state.data.current ?? state.data.deliveries[0] ?? null
  const summary = useMemo(() => summarizeTrackbookDelivery(delivery, card), [delivery, card.title, card.description])
  const openFullTrackbook = () => {
    if (state.workspaceId === null) return
    localStorage.setItem('orchestra-os-workspace', String(state.workspaceId))
    localStorage.setItem('orchestra-os-pane', 'trackbook')
    onOpenFull()
    window.requestAnimationFrame(() => {
      const workspaceTab = document.getElementById('board-tab-workspace')
      if (workspaceTab instanceof HTMLButtonElement) workspaceTab.click()
    })
  }

  return (
    <section className="drawer-trackbook" aria-labelledby={`drawer-trackbook-title-${card.id}`} aria-busy={state.status === 'loading'}>
      <header>
        <div><span className="drawer-trackbook-icon"><OsIcon name="evidence" size={15} /></span><h3 id={`drawer-trackbook-title-${card.id}`}>Trackbook</h3></div>
        {delivery && <span className="drawer-trackbook-revision">Revision {delivery.sequence || '—'}</span>}
      </header>

      {state.status === 'loading' && (
        <div className="drawer-trackbook-loading" role="status"><span /><span /><span className="sr-only">Loading Trackbook</span></div>
      )}
      {state.status === 'error' && (
        <div className="drawer-trackbook-state error" role="status"><OsIcon name="attention" size={14} /><div><strong>Trackbook unavailable</strong><p>{state.error}</p></div></div>
      )}
      {state.status === 'ready' && (
        <>
          <h4 className={`drawer-trackbook-headline ${summary.tone}`}>{summary.headline}</h4>
          <dl className="drawer-trackbook-compare">
            <div><dt>Asked</dt><dd>{summary.asked}</dd></div>
            <div><dt>Delivered</dt><dd>{summary.delivered}</dd></div>
            <div><dt>Delta</dt><dd>{delivery
              ? summary.total ? `${summary.complete} supported · ${summary.needsEvidence} need evidence · ${summary.failed} failed`
                : 'No promise-to-result mapping yet.'
              : 'A delivery report is still needed.'}</dd></div>
          </dl>
          {delivery?.delivered_items.length ? (
            <p className="drawer-trackbook-claims"><OsIcon name="message" size={12} /> {delivery.delivered_items.length} reported item{delivery.delivered_items.length === 1 ? '' : 's'}; claims are not counted as evidence.</p>
          ) : null}
          {state.workspaceId !== null ? (
            <button className="drawer-trackbook-open" type="button" onClick={openFullTrackbook}>
              Open full Trackbook <OsIcon name="chevron" size={13} />
            </button>
          ) : (
            <p className="drawer-trackbook-unlinked">Full evidence becomes available when this card is linked to a workspace.</p>
          )}
        </>
      )}
    </section>
  )
}
