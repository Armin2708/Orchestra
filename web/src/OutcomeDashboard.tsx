import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, streamUrl } from './api'
import { createSingleFlightRefresh } from './singleFlightRefresh'
import './outcome-dashboard.css'

type Dashboard = {
  board_id: number
  window: { since: string; until: string }
  production_signals: {
    provider_usage: 'available'
    child_dispatch: 'available'
    context_injection: 'unavailable'
    context_selection: 'knowledge_context_use_receipts'
    exploration: 'claude_native_read_receipts'
    first_useful_result: 'accepted_delivery_receipts'
    model_acknowledgement: 'unavailable'
    high_fanout_preflight: 'operator_plan_only'
  }
  usage: {
    provider_tokens: number
    input_tokens: number
    cached_input_tokens: number
    output_tokens: number
    thinking_tokens: number
    context_injection_tokens: null
    cached_input_ratio: number | null
    accepted_delivery_tokens: number
    accepted_deliveries: number
    tokens_per_accepted_delivery: number | null
  }
  context: { selected: number; reused: number; rejected: number; refreshed: number; uses: number }
  coordination: { wakes: number; fanout: number; model_acknowledgements: number }
  exploration: { reads: number; likely_duplicates: number; duplicate_rate: number | null }
  speed: {
    average_ms_to_first_useful_result: number | null
    average_ms_to_verified_delivery: number | null
  }
  quality: {
    reports: number
    accepted: number
    rejected: number
    evidence_gaps: number
    retries: number
    retry_source: 'os_events'
    human_overrides: number
    rejection_rate: number | null
    evidence_gap_rate: number | null
    human_override_rate: number | null
  }
  budgets: Array<{
    policy_id: string
    scope_kind: string
    scope_id: string
    warning: boolean
    exceeded: boolean
    allowed: boolean
  }>
  by_job: Array<{
    job_id: string
    contract_ref: string
    provider_tokens: number
    context_tokens: null
    accepted: number
  }>
  by_team: Array<{ team_id: string; provider_tokens: number; context_tokens: null }>
}

const integer = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 })
const percent = new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 1 })

const formatCount = (value: number | null) => value === null ? 'Not observed' : integer.format(value)
const formatRate = (value: number | null) => value === null ? 'Not observed' : percent.format(value)
const formatDuration = (value: number | null) => {
  if (value === null) return 'Not observed'
  if (value < 60_000) return `${Math.round(value / 1_000)}s`
  if (value < 3_600_000) return `${Math.round(value / 60_000)}m`
  return `${(value / 3_600_000).toFixed(1)}h`
}

export function OutcomeDashboard({ boardId }: { boardId: number }) {
  const [dashboard, setDashboard] = useState<Dashboard | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const refreshRequest = useRef<(visible?: boolean) => void>(() => {})

  const load = useCallback(async () => {
    const requestedBoard = boardId
    const next = await api('GET', `/os/boards/${requestedBoard}/outcomes/dashboard`) as Dashboard
    if (next.board_id !== requestedBoard) throw new Error('Outcome dashboard returned another board')
    return next
  }, [boardId])

  useEffect(() => {
    setDashboard(null)
    setError(null)
    setLoading(true)
    const stream = new EventSource(streamUrl())
    let pending: number | undefined
    let retry: number | undefined
    let initialRequest = true
    let disposed = false
    const controller = createSingleFlightRefresh({
      load,
      onStart: (visible) => {
        if (visible) setLoading(true)
      },
      onSuccess: (next) => {
        setDashboard(next)
        setError(null)
      },
      onFailure: (reason) => {
        setError(reason instanceof Error ? reason.message : 'Outcome dashboard could not load')
      },
      onSettled: (visible) => {
        if (visible) setLoading(false)
      },
      onCycle: ({ succeeded, queued }) => {
        if (!succeeded && !queued && retry === undefined) {
          retry = window.setTimeout(() => {
            if (disposed) return
            retry = undefined
            controller.request()
          }, 1_000)
        }
      },
    })
    const requestRefresh = () => {
      const visible = initialRequest
      initialRequest = false
      controller.request(visible)
    }
    refreshRequest.current = (visible = true) => controller.request(visible)
    stream.onopen = () => {
      if (disposed) return
      if (retry !== undefined) {
        window.clearTimeout(retry)
        retry = undefined
      }
      requestRefresh()
    }
    const initialFallback = window.setTimeout(requestRefresh, 1_000)
    stream.onmessage = (event) => {
      if (disposed) return
      let payload: { board_id?: number; type?: string }
      try { payload = JSON.parse(event.data) as { board_id?: number; type?: string } } catch { return }
      if (payload.board_id !== boardId || payload.type !== 'outcome_analytics') return
      if (pending !== undefined) window.clearTimeout(pending)
      pending = window.setTimeout(() => {
        if (disposed) return
        pending = undefined
        controller.request()
      }, 250)
    }
    return () => {
      disposed = true
      controller.dispose()
      refreshRequest.current = () => {}
      stream.close()
      window.clearTimeout(initialFallback)
      if (retry !== undefined) window.clearTimeout(retry)
      if (pending !== undefined) window.clearTimeout(pending)
    }
  }, [load])

  const qualityTone = useMemo(() => {
    if (!dashboard || dashboard.quality.reports === 0) return 'neutral'
    if (dashboard.quality.evidence_gaps || dashboard.quality.rejected) return 'attention'
    return 'healthy'
  }, [dashboard])

  if (dashboard && dashboard.board_id !== boardId) {
    return <div className="outcome-dashboard-state" aria-live="polite">Loading outcome evidence…</div>
  }
  if (loading && !dashboard) return <div className="outcome-dashboard-state" aria-live="polite">Loading outcome evidence…</div>
  if (error && !dashboard) return <div className="outcome-dashboard-state error" role="alert">{error}</div>
  if (!dashboard) return null

  return (
    <section className="outcome-dashboard" aria-labelledby="outcome-dashboard-title">
      <header className="outcome-dashboard-header">
        <div>
          <p className="outcome-dashboard-eyebrow">Quality-aware efficiency</p>
          <h2 id="outcome-dashboard-title">Outcome dashboard</h2>
          <p>Token reduction counts only when accepted-delivery quality holds.</p>
          <p>Live beta signals cover provider usage, child dispatch, immutable knowledge-context
            receipts, accepted-delivery timing, and Claude-native Read receipts. Exact context-token
            injection, model acknowledgement, and provider-native high-fanout preflight remain unavailable.</p>
        </div>
        <button type="button" onClick={() => refreshRequest.current(true)} disabled={loading}>
          {loading ? 'Refreshing…' : 'Refresh evidence'}
        </button>
      </header>

      {error && <div className="outcome-dashboard-warning" role="status">Showing retained data: {error}</div>}

      <div className="outcome-metric-grid">
        <Metric label="Tokens / accepted delivery" value={formatCount(dashboard.usage.tokens_per_accepted_delivery)} detail={`${formatCount(dashboard.usage.accepted_deliveries)} accepted`} />
        <Metric label="Cached-input ratio" value={formatRate(dashboard.usage.cached_input_ratio)} detail={`${formatCount(dashboard.usage.cached_input_tokens)} cached tokens`} />
        <Metric label="First useful result" value={formatDuration(dashboard.speed.average_ms_to_first_useful_result)} detail="Accepted-delivery receipt from job start" />
        <Metric label="Verified delivery" value={formatDuration(dashboard.speed.average_ms_to_verified_delivery)} detail="Average from job start" />
      </div>

      <div className="outcome-dashboard-columns">
        <article className={`outcome-panel ${qualityTone}`}>
          <header><h3>Verified quality</h3><span>{dashboard.quality.accepted}/{dashboard.quality.reports} accepted</span></header>
          <dl>
            <Data label="Evidence-gap rate" value={formatRate(dashboard.quality.evidence_gap_rate)} />
            <Data label="Rejection rate" value={formatRate(dashboard.quality.rejection_rate)} />
            <Data label="Human-override rate" value={formatRate(dashboard.quality.human_override_rate)} />
            <Data label="Retries" value={formatCount(dashboard.quality.retries)} />
          </dl>
        </article>

        <article className="outcome-panel">
          <header><h3>Context and coordination</h3><span>{dashboard.context.uses} context uses</span></header>
          <dl>
            <Data label="Context selected / reused" value={`${dashboard.context.selected} / ${dashboard.context.reused}`} />
            <Data label="Rejected / refreshed" value={`${dashboard.context.rejected} / ${dashboard.context.refreshed}`} />
            <Data label="Wakes / total fanout" value={`${dashboard.coordination.wakes} / ${dashboard.coordination.fanout}`} />
            <Data label="Model acknowledgements" value="Not available" />
            <Data label="Repeated Claude Read inputs" value={dashboard.exploration.reads === 0
              ? 'Not observed'
              : `${dashboard.exploration.likely_duplicates} / ${dashboard.exploration.reads}`} />
          </dl>
        </article>
      </div>

      <article className="outcome-table-panel">
        <header><h3>Job attribution</h3><span>{dashboard.by_job.length} measured jobs</span></header>
        {dashboard.by_job.length === 0 ? (
          <p className="outcome-empty">No scoped provider observations in this window.</p>
        ) : (
          <div className="outcome-table-scroll">
            <table>
              <thead><tr><th>Job</th><th>Contract</th><th>Provider</th><th>Context</th><th>Delivery</th></tr></thead>
              <tbody>{dashboard.by_job.map((job) => (
                <tr key={job.job_id}>
                  <td><code>{job.job_id}</code></td>
                  <td><code>{job.contract_ref}</code></td>
                  <td>{formatCount(job.provider_tokens)}</td>
                  <td>Not available</td>
                  <td><span className={job.accepted ? 'outcome-status accepted' : 'outcome-status'}>{job.accepted ? 'Accepted' : 'Open'}</span></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </article>
    </section>
  )
}

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return <article className="outcome-metric"><span>{label}</span><strong>{value}</strong><small>{detail}</small></article>
}

function Data({ label, value }: { label: string; value: string }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>
}
