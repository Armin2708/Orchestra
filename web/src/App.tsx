import React, { useCallback, useEffect, useState } from 'react'
import { api, ApiError, setToken, streamUrl, Snapshot , SystemInfo, Telemetry } from './api'
import { ProjectGrid } from './Board'
import { RoadmapView } from './RoadmapView'
import { pushSupported, isSubscribed, subscribe, unsubscribe } from './push'

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
  const [view, setView] = useState<'board' | 'roadmap'>(() =>
    (localStorage.getItem('orchestra-view') as 'board' | 'roadmap') ?? 'board')
  const pickView = (v: 'board' | 'roadmap') => { setView(v); localStorage.setItem('orchestra-view', v) }
  const pick = (f: number | 'all') => { setFocus(f); setMenuOpen(false); localStorage.setItem('orchestra-focus', String(f)) }

  // a notification tap lands on /?board=<id>[&card=<id>] — focus that board;
  // the card param is picked up by ProjectGrid once snapshots arrive
  useEffect(() => {
    const b = Number(new URLSearchParams(location.search).get('board'))
    if (b) { setFocus(b); localStorage.setItem('orchestra-focus', String(b)) }
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
  if (loaded && snaps.length === 0) return <GettingStarted />

  const agents = snaps.flatMap((s) => s.agents.filter((a) => a.status !== 'gone'))
  const cards = snaps.flatMap((s) => s.cards)
  const visible = focus === 'all' ? snaps : snaps.filter((s) => s.board.id === focus)
  const shown = visible.length > 0 ? visible : snaps // focused board was removed — fall back

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
        <SystemMeter boards={snaps.map((s) => s.board.id)} />
        <nav className="view-tabs">
          <button className={view === 'board' ? 'tab active' : 'tab'} onClick={() => pickView('board')}>Board</button>
          <button className={view === 'roadmap' ? 'tab active' : 'tab'} onClick={() => pickView('roadmap')}>Roadmap</button>
          <PushBell />
        </nav>
      </header>
      {view === 'board'
        ? <ProjectGrid snaps={shown} focused={focus !== 'all' && visible.length === 1} onChange={refresh} />
        : <RoadmapView snaps={shown} focused={focus !== 'all' && visible.length === 1} onChange={refresh} />}
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
      title={state === 'on' ? 'Notifications on for this device — tap to turn off' : 'Notify this device when agents finish, block, or ask'}>
      {state === 'on' ? '🔔' : '🔕'}
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

function GettingStarted() {
  return (
    <div className="empty-hero">
      <div className="empty-card">
        <Mark />
        <h1>No projects yet</h1>
        <p>A project appears the moment an agent joins it. Open a Claude Code session in any repo and it joins on its own:</p>
        <pre>cd your-project{'\n'}claude</pre>
        <p className="hint">This page updates live — leave it open.</p>
      </div>
    </div>
  )
}

const fmtTokens = (t: number) =>
  t >= 1_000_000 ? `${(t / 1_000_000).toFixed(1)}M` : t >= 1000 ? `${(t / 1000).toFixed(1)}k` : String(t)

function SystemMeter({ boards }: { boards: number[] }) {
  const [sys, setSys] = useState<SystemInfo | null>(null)
  const [inj, setInj] = useState<Telemetry | null>(null)
  useEffect(() => {
    let dead = false
    const load = () => api('GET', '/system').then((s) => { if (!dead) setSys(s) }).catch(() => {})
    load()
    const t = setInterval(load, 60_000)
    return () => { dead = true; clearInterval(t) }
  }, [])
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
  const at = (iso: string | null) => iso
    ? new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : null
  const remedy = 'restart orchestra from an interactive terminal (orchestra restart) and choose "Always Allow" on the keychain prompt'
  const stale = sys?.usage?.stale_since
  const win = (label: string, w: { utilization: number; resets_at: string | null }) => {
    const used = Math.round(w.utilization)
    const reset = at(w.resets_at)
    const staleNote = stale ? ` — cached ${at(stale)}, live fetch failing (${sys!.usage_error}); ${remedy}` : ''
    return (
      <span className={`meter ${used >= 85 ? 'low' : ''} ${stale ? 'stale' : ''}`} title={`${label} limit: ${used}% used${reset ? ` — resets ${reset}` : ''}${staleNote}`}>
        <span className="meter-label">{label}</span>
        <span className="meter-bar"><i style={{ width: `${Math.min(100, used)}%` }} /></span>
        <span className="meter-val">{used}%</span>
        {reset && <span className="meter-reset">↺ {reset}</span>}
      </span>
    )
  }
  return (
    <div className="sysmeter">
      <span className="meter" title={`${sys.hired} hired agents running — this machine (${sys.hardware.cores} cores, ${sys.hardware.total_gb}GB) can comfortably run about ${sys.hardware.capacity}`}>
        <span className="meter-label">agents</span>
        <span className="meter-val">{sys.hired}/{sys.hardware.capacity}</span>
      </span>
      {sys.usage && win('5h', sys.usage.five_hour)}
      {sys.usage && win('week', sys.usage.seven_day)}
      {!sys.usage && sys.usage_error && (
        <span className="meter degraded"
          title={`Claude usage unavailable (${sys.usage_error})${sys.usage_error_since ? ` since ${at(sys.usage_error_since)}` : ''} — ${remedy}.`}>
          <span className="meter-label">usage</span>
          <span className="meter-val">unavailable ({sys.usage_error})</span>
        </span>
      )}
      {sys.injected && sys.injected.count > 0 && (
        <span className="meter"
          title={`orchestra injected ~${sys.injected.tokens.toLocaleString()} tokens into agent contexts across ${sys.injected.count} hook emissions (estimated as chars/4)${inj && inj.by_agent.length > 0 ? ` — top agents: ${inj.by_agent.slice(0, 5).map((a) => `${a.agent_name} ${fmtTokens(a.tokens)}`).join(', ')}` : ''}`}>
          <span className="meter-label">injected</span>
          <span className="meter-val">{fmtTokens(sys.injected.tokens)} tok</span>
        </span>
      )}
    </div>
  )
}
