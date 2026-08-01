import React, { useCallback, useEffect, useState } from 'react'
import { api, ApiError, setToken, streamUrl, Snapshot, SystemInfo, Telemetry } from './api'
import { BoardSection } from './BoardSection'
import { BoardTab, PrimaryView, resolveStoredNavigation } from './boardNavigation'
import { RoadmapView } from './RoadmapView'
import { NeedsYou } from './NeedsYou'
import { OsIcon } from './OsIcon'
import { pushSupported, isSubscribed, subscribe, unsubscribe } from './push'
import { wakeMeter } from './wake'
import { highestSubscriptionUsage, subscriptionUsage, type SubscriptionUsageProvider } from './providerUsage'
import './messages.css'
import './agentOs.css'

const SettingsView = React.lazy(() => import('./SettingsView').then((module) => ({ default: module.SettingsView })))
const OpenWorkView = React.lazy(() => import('./OpenWorkView').then((module) => ({ default: module.OpenWorkView })))
export const Mark = () => (
  <svg className="mark" viewBox="0 0 32 32" aria-hidden="true">
    <rect width="32" height="32" rx="8" fill="#111"/>
    <rect x="7" y="9" width="5" height="14" rx="1.5" fill="#F7F6F3"/>
    <rect x="14" y="9" width="5" height="9" rx="1.5" fill="#F7F6F3"/>
    <rect x="21" y="9" width="5" height="11" rx="1.5" fill="#F7F6F3"/>
  </svg>
)

export function App() {
  const [snaps, setSnaps] = useState<Snapshot[]>([])
  const [loaded, setLoaded] = useState(false)
  const [needsAuth, setNeedsAuth] = useState(false)
  const [focus, setFocus] = useState<number | 'all'>(() => {
    const saved = localStorage.getItem('orchestra-focus')
    return saved && saved !== 'all' ? Number(saved) : 'all'
  })
  const [menuOpen, setMenuOpen] = useState(false)
  const [navigation, setNavigation] = useState(() => resolveStoredNavigation(
    localStorage.getItem('orchestra-view'), localStorage.getItem('orchestra-board-tab')))
  const { view, boardTab } = navigation
  const pickView = (next: PrimaryView) => setNavigation((current) => ({ ...current, view: next }))
  const pickBoardTab = (next: BoardTab) => setNavigation({ view: 'board', boardTab: next })
  const pick = (f: number | 'all') => { setFocus(f); setMenuOpen(false); localStorage.setItem('orchestra-focus', String(f)) }

  useEffect(() => {
    localStorage.setItem('orchestra-view', view)
    localStorage.setItem('orchestra-board-tab', boardTab)
  }, [view, boardTab])

  // a notification tap lands on /?board=<id>[&card=<id>] — focus that board;
  // the card param is picked up by ProjectGrid once snapshots arrive
  useEffect(() => {
    const params = new URLSearchParams(location.search)
    const b = Number(params.get('board'))
    if (b) { setFocus(b); localStorage.setItem('orchestra-focus', String(b)) }
    if (['agent', 'session', 'conversation'].some((key) => params.has(key))) {
      setNavigation({ view: 'board', boardTab: 'agents' })
    } else if (params.has('card')) setNavigation({ view: 'board', boardTab: 'overview' })
  }, [])

  // default to the first project (network view) rather than the all-projects grid
  useEffect(() => {
    if (focus === 'all' && !localStorage.getItem('orchestra-focus') && snaps[0]) pick(snaps[0].board.id)
  }, [snaps.length])

  const refresh = useCallback(async () => {
    try {
      const boards = await api('GET', '/boards')
      const all = await Promise.all(boards.map((b: any) => api('GET', `/boards/${b.id}/snapshot`)))
      setSnaps(all)
      setNeedsAuth(false)
      return boards
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setNeedsAuth(true)
      return []
    } finally {
      setLoaded(true)
    }
  }, [])

  useEffect(() => {
    if (needsAuth) return // no stream until the token is accepted
    refresh()
    // a single stream for everything — per-board streams exhaust the browser connection limit
    const es = new EventSource(streamUrl())
    let pending: number | undefined
    es.onmessage = () => {
      // debounce bursts of events into one refresh
      if (pending) return
      pending = window.setTimeout(() => { pending = undefined; refresh() }, 300)
    }
    const poll = setInterval(refresh, 30_000) // pick up newly created boards
    return () => { es.close(); clearInterval(poll); if (pending) clearTimeout(pending) }
  }, [refresh, needsAuth])

  if (needsAuth) return <Login onSubmit={(t) => { setToken(t); setNeedsAuth(false) }} />
  const agents = snaps.flatMap((s) => s.agents.filter((a) => a.status !== 'gone'))
  const cards = snaps.flatMap((s) => s.cards)
  const visible = focus === 'all' ? snaps : snaps.filter((s) => s.board.id === focus)
  const shown = visible.length > 0 ? visible : snaps // focused board was removed — fall back
  const openMessages = shown.reduce((sum, snap) => sum + snap.open_questions.length, 0)

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <Mark />
          <div className="brand-picker">
            <button className="brand-btn" onClick={() => setMenuOpen((o) => !o)}>
              <h1>{focus === 'all' ? 'All projects' : shown[0]?.board.name ?? 'Orchestra'}</h1>
              <span className="brand-caret">▾</span>
            </button>
            <p className="sub">
              {snaps.length} project{snaps.length === 1 ? '' : 's'} · {agents.length} agent{agents.length === 1 ? '' : 's'} active · {cards.length} card{cards.length === 1 ? '' : 's'}
            </p>
            {menuOpen && (
              <div className="brand-menu">
                <button className={focus === 'all' ? 'brand-item active' : 'brand-item'} onClick={() => pick('all')}>All projects</button>
                {snaps.map((s) => (
                  <button key={s.board.id} className={focus === s.board.id ? 'brand-item active' : 'brand-item'}
                    onClick={() => pick(s.board.id)}>
                    {s.board.name}
                    <span className="brand-count">{s.agents.filter((a) => a.status !== 'gone').length}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="topbar-actions">
          <SystemMeter boards={snaps.map((s) => s.board.id)} />
          <nav className="view-tabs">
            <button className={view === 'board' ? 'tab active' : 'tab'} onClick={() => pickView('board')}>Board</button>
            <button className={view === 'open-work' ? 'tab active' : 'tab'} onClick={() => pickView('open-work')}>Open Work</button>
            <button className={view === 'roadmap' ? 'tab active' : 'tab'} onClick={() => pickView('roadmap')}>Roadmap</button>
            <button className={view === 'settings' ? 'tab active' : 'tab'} onClick={() => pickView('settings')}>Settings</button>
            <NeedsYou boards={snaps.map((snapshot) => snapshot.board)} onOpen={(item) => {
              if (item.workspace_id !== null) localStorage.setItem('orchestra-os-workspace', String(item.workspace_id))
              pick(item.board_id)
              pickBoardTab('workspace')
            }} />
            <PushBell />
          </nav>
        </div>
      </header>
      {view === 'board'
        ? loaded && snaps.length === 0
          ? <GettingStarted onSettings={() => pickView('settings')} />
          : <BoardSection tab={boardTab} snaps={shown} focused={focus !== 'all' && visible.length === 1}
              openMessages={openMessages} onTabChange={pickBoardTab} onChange={refresh} />
        : view === 'open-work'
          ? <React.Suspense fallback={<div className="os-view-loading" aria-label="Loading Open Work"><span /><span /><span /></div>}>
              <OpenWorkView />
            </React.Suspense>
        : view === 'roadmap'
          ? <RoadmapView snaps={shown} focused={focus !== 'all' && visible.length === 1} onChange={refresh} />
          : <React.Suspense fallback={<div className="os-view-loading" aria-label="Loading settings"><span /><span /><span /></div>}>
              <SettingsView />
            </React.Suspense>}
    </div>
  )
}

// per-device opt-in for phone notifications — the subscription lives in this browser
function PushBell() {
  const [state, setState] = useState<'unsupported' | 'off' | 'on' | 'busy'>('unsupported')
  useEffect(() => {
    if (pushSupported()) isSubscribed().then((on) => setState(on ? 'on' : 'off'))
  }, [])
  if (state === 'unsupported') return null
  const toggle = async () => {
    const prev = state
    setState('busy')
    try {
      if (prev === 'on') { await unsubscribe(); setState('off') }
      else { await subscribe(); setState('on') }
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e))
      setState(prev)
    }
  }
  return (
    <button className="tab" onClick={toggle} disabled={state === 'busy'} aria-pressed={state === 'on'}
      aria-label={state === 'on' ? 'Turn notifications off for this device' : 'Turn notifications on for this device'}
      title={state === 'on' ? 'Notifications on for this device — tap to turn off' : 'Notify this device when agents finish, block, or ask'}>
      <OsIcon name="bell" />
      <span className="sr-only">{state === 'on' ? 'Notifications on' : 'Notifications off'}</span>
      <span className={`notification-state ${state}`} aria-hidden="true" />
    </button>
  )
}

function Login({ onSubmit }: { onSubmit: (token: string) => void }) {
  const [token, setTokenInput] = useState('')
  return (
    <div className="empty-hero">
      <div className="empty-card">
        <Mark />
        <h1>Connect to Orchestra</h1>
        <p>This daemon requires a token. Print it from the machine running Orchestra:</p>
        <pre>orchestra token</pre>
        <form className="login-form" onSubmit={(e) => { e.preventDefault(); if (token.trim()) onSubmit(token.trim()) }}>
          <input className="login-input" type="password" placeholder="Paste token" autoFocus
            value={token} onChange={(e) => setTokenInput(e.target.value)} />
          <button className="login-btn" type="submit" disabled={!token.trim()}>Connect</button>
        </form>
        <p className="hint">Stored only in this browser. You won't be asked again.</p>
      </div>
    </div>
  )
}

function GettingStarted({ onSettings }: { onSettings: () => void }) {
  return (
    <div className="empty-hero">
      <div className="empty-card">
        <Mark />
        <h1>No projects yet</h1>
        <p>A project appears the moment an agent joins it. Open a Claude Code session in any repo and it joins on its own:</p>
        <pre>cd your-project{'\n'}claude</pre>
        <button className="login-btn" type="button" onClick={onSettings}>Configure agent defaults</button>
        <p className="hint">This page updates live — leave it open.</p>
      </div>
    </div>
  )
}

const fmtTokens = (t: number) =>
  t >= 1_000_000 ? `${(t / 1_000_000).toFixed(1)}M` : t >= 1000 ? `${(t / 1000).toFixed(1)}k` : String(t)

// agents paused by usage limits: one-click wake-all, with the autowake timer's fire time
// when the daemon will do it on its own (#62)
function WakeButton({ boards, sys, reload }: { boards: number[]; sys: SystemInfo; reload: () => void }) {
  const [busy, setBusy] = useState(false)
  const m = wakeMeter(sys.paused_limit ?? 0, sys.autowake_at, sys.autowake_enabled, busy)
  if (!m) return null
  const wake = async () => {
    setBusy(true)
    try {
      for (const id of boards) await api('POST', `/boards/${id}/wake`)
    } catch { /* the meter refresh below re-reads the real state */ }
    setBusy(false)
    reload()
  }
  return (
    <button className="meter meter-wake" disabled={busy} onClick={wake} title={m.title}>
      <span className="meter-label">paused</span>
      <span className="meter-val">{m.label}</span>
      {m.auto && <span className="meter-reset">{m.auto}</span>}
    </button>
  )
}

const usageReset = (iso: string | null) => iso
  ? new Date(iso).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })
  : null

function SubscriptionUsage({ sys }: { sys: SystemInfo }) {
  const providers = subscriptionUsage(sys)
  const highest = highestSubscriptionUsage(providers)
  const renderProvider = (provider: SubscriptionUsageProvider) => (
    <section className={`usage-provider${provider.stale ? ' is-stale' : ''}`} key={provider.id}>
      <header>
        <strong>{provider.name}</strong>
        {provider.account && <span>{provider.account}</span>}
        {provider.stale && <em>cached</em>}
      </header>
      {provider.windows.map((window) => {
        const reset = usageReset(window.resetsAt)
        return (
          <div className={`usage-window${window.used >= 85 ? ' is-high' : ''}`} key={window.id}>
            <div className="usage-window-copy">
              <span>{window.label}</span>
              <b>{Math.round(window.used)}%</b>
              {reset && <small>resets {reset}</small>}
            </div>
            <span className="usage-window-bar" aria-hidden="true"><i style={{ width: `${window.used}%` }} /></span>
          </div>
        )
      })}
      {provider.detail && <p>{provider.detail}</p>}
      {provider.windows.length === 0 && !provider.detail && <p>No subscription limit data available.</p>}
      {(provider.lifetimeTokens !== undefined || provider.resetCredits !== undefined) && (
        <footer>
          {provider.lifetimeTokens !== undefined && <span>{fmtTokens(provider.lifetimeTokens)} lifetime tokens</span>}
          {provider.resetCredits !== undefined && <span>{provider.resetCredits} reset credit{provider.resetCredits === 1 ? '' : 's'}</span>}
        </footer>
      )}
    </section>
  )
  return (
    <details className="usage-menu">
      <summary className={`meter meter-usage${highest !== null && highest >= 85 ? ' low' : ''}`}
        aria-label="AI subscription usage">
        <span className="meter-label">usage</span>
        <span className="meter-val">{highest === null ? '—' : `${Math.round(highest)}%`}</span>
        <span className="usage-caret" aria-hidden="true">⌄</span>
      </summary>
      <div className="usage-popover" role="dialog" aria-label="AI subscription usage details">
        <div className="usage-popover-head">
          <strong>Subscription usage</strong>
          <span>Live provider limits</span>
        </div>
        {providers.length > 0 ? providers.map(renderProvider) : (
          <p className="usage-empty">No subscription usage is available.</p>
        )}
      </div>
    </details>
  )
}

function SystemMeter({ boards }: { boards: number[] }) {
  const [sys, setSys] = useState<SystemInfo | null>(null)
  const [inj, setInj] = useState<Telemetry | null>(null)
  const loadSys = useCallback(() => api('GET', '/system').then(setSys).catch(() => {}), [])
  useEffect(() => {
    loadSys()
    const t = setInterval(loadSys, 60_000)
    return () => clearInterval(t)
  }, [loadSys])
  // injected-context accounting; daemons without the telemetry route just hide the stat
  const boardKey = boards.join(',')
  useEffect(() => {
    let dead = false
    const load = async () => {
      const parts: Telemetry[] = (await Promise.all(
        boardKey.split(',').filter(Boolean).map((id) => api('GET', `/boards/${id}/telemetry`).catch(() => null)),
      )).filter(Boolean)
      if (dead || parts.length === 0) return
      const agents = new Map<string, number>()
      for (const p of parts) for (const a of p.by_agent) agents.set(a.agent_name, (agents.get(a.agent_name) ?? 0) + a.tokens)
      setInj({
        total: {
          chars: parts.reduce((n, p) => n + p.total.chars, 0),
          tokens: parts.reduce((n, p) => n + p.total.tokens, 0),
          count: parts.reduce((n, p) => n + p.total.count, 0),
        },
        by_event: [],
        by_agent: [...agents].map(([agent_name, tokens]) => ({ agent_id: 0, agent_name, tokens, chars: 0, count: 0 }))
          .sort((a, b) => b.tokens - a.tokens),
        days: [],
      })
    }
    load()
    const t = setInterval(load, 60_000)
    return () => { dead = true; clearInterval(t) }
  }, [boardKey])
  if (!sys) return null
  return (
    <div className="sysmeter">
      <span className="meter" title={`${sys.hired} hired agents running — this machine (${sys.hardware.cores} cores, ${sys.hardware.total_gb}GB) can comfortably run about ${sys.hardware.capacity}`}>
        <span className="meter-label">agents</span>
        <span className="meter-val">{sys.hired}/{sys.hardware.capacity}</span>
      </span>
      <WakeButton boards={boards} sys={sys} reload={loadSys} />
      <SubscriptionUsage sys={sys} />
      {sys.injected && sys.injected.count > 0 && (
        <span className="meter"
          title={`orchestra injected ~${sys.injected.tokens.toLocaleString()} tokens into agent contexts across ${sys.injected.count} hook emissions (estimated as chars/4)${inj && inj.by_agent.length > 0 ? ` — top agents: ${inj.by_agent.slice(0, 5).map((a) => `${a.agent_name} ${fmtTokens(a.tokens)}`).join(', ')}` : ''}`}>
          <span className="meter-label">injected</span>
          <span className="meter-val">{fmtTokens(sys.injected.tokens)} tok</span>
        </span>
      )}
      {sys.agent_usage && (() => {
        // real API tokens (from SDK usage reports) — a different animal than the injected estimate above
        const u = sys.agent_usage
        const inTok = u.input_tokens + u.cache_read + u.cache_creation
        if (inTok + u.output_tokens === 0) return null
        const cached = inTok > 0 ? Math.round(100 * u.cache_read / inTok) : 0
        return (
          <span className="meter"
            title={`real API tokens consumed by hired agents (all boards, from SDK usage reports — not an estimate): input ${u.input_tokens.toLocaleString()} · cache read ${u.cache_read.toLocaleString()} (${cached}% of intake) · cache write ${u.cache_creation.toLocaleString()} · output ${u.output_tokens.toLocaleString()}`}>
            <span className="meter-label">api tok</span>
            <span className="meter-val">↑ {fmtTokens(inTok)} · ↓ {fmtTokens(u.output_tokens)}</span>
          </span>
        )
      })()}
    </div>
  )
}
