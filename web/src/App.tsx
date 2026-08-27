import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  api,
  ApiError,
  authenticateLocalOwnerPassword,
  getToken,
  localOwnerPasswordStatus,
  setToken,
  streamUrl,
  Snapshot,
  SystemInfo,
  Telemetry,
} from './api'
import { BoardSection } from './BoardSection'
import { ConfirmDialog } from './ConfirmDialog'
import {
  BoardTab, normalizeProjectFocus, PrimaryView, resolveLocationNavigation, resolveProjectFocus,
} from './boardNavigation'
import { boardIdFromSearch } from './boardDeepLink'
import { StateMessage } from './StateMessage'
import { loadReadMap, needsAttention, READ_MAP_EVENT } from './messageUi'
import { NeedsYou } from './NeedsYou'
import { OsIcon } from './OsIcon'
import { pushSupported, isSubscribed, subscribe, unsubscribe } from './push'
import { wakeMeter } from './wake'
import {
  highestSubscriptionUsage, selectedUsageProvider, subscriptionUsage, type SubscriptionUsageProvider,
} from './providerUsage'
import { DaemonDownOverlay, OfflineStateBanner, RemoteAccessProvider } from './RemoteAccess'
import { PhoneRemoteDock } from './PhoneRemoteDock'
import { PairingRequired, RemoteDeviceShell } from './RemoteDeviceShell'
import type { BrowserAuthorityMode } from './deviceAuth'
import { createSingleFlightRefresh } from './singleFlightRefresh'
import {
  beginLocalOwnerAuthentication,
  beginLocalOwnerRetry,
  LocalOwnerConnecting,
  LocalOwnerInitialOffline,
  resolveLocalOwnerSurface,
} from './LocalOwnerStartup'
import './messages.css'
import './agentOs.css'

const SettingsView = React.lazy(() => import('./SettingsView').then((module) => ({ default: module.SettingsView })))
export const Mark = () => (
  <svg className="mark" viewBox="0 0 32 32" aria-hidden="true">
    <rect width="32" height="32" rx="8" fill="#111"/>
    <rect x="7" y="9" width="5" height="14" rx="1.5" fill="#F7F6F3"/>
    <rect x="14" y="9" width="5" height="9" rx="1.5" fill="#F7F6F3"/>
    <rect x="21" y="9" width="5" height="11" rx="1.5" fill="#F7F6F3"/>
  </svg>
)

export function App({ authorityMode = 'local-owner', onAuthorityChanged }: {
  authorityMode?: BrowserAuthorityMode
  onAuthorityChanged?: () => void
}) {
  if (authorityMode === 'paired-device') return <RemoteDeviceShell />
  if (authorityMode === 'pairing-required') return <PairingRequired onSignedIn={onAuthorityChanged} />
  return <LocalOwnerApp />
}

function LocalOwnerApp() {
  const [snaps, setSnaps] = useState<Snapshot[]>([])
  const [loaded, setLoaded] = useState(false)
  const [connectionState, setConnectionState] = useState<'live' | 'stale' | 'offline'>('offline')
  const hasConnectedRef = useRef(false)
  const refreshRequest = useRef<() => void>(() => {})
  const refresh = useCallback(() => refreshRequest.current(), [])
  const [locationSearch, setLocationSearch] = useState(location.search)
  const [needsAuth, setNeedsAuth] = useState(false)
  // read state lives in localStorage (written by MessagesView); resync so the
  // badge clears as mail is read, in this tab and others
  const [inboxRead, setInboxRead] = useState(() => loadReadMap())
  useEffect(() => {
    const sync = () => setInboxRead(loadReadMap())
    window.addEventListener(READ_MAP_EVENT, sync)
    window.addEventListener('storage', sync)
    return () => { window.removeEventListener(READ_MAP_EVENT, sync); window.removeEventListener('storage', sync) }
  }, [])
  const [focus, setFocus] = useState<number | 'all'>(() => {
    return normalizeProjectFocus(localStorage.getItem('orchestra-focus'))
  })
  const [menuOpen, setMenuOpen] = useState(false)
  const [addingProject, setAddingProject] = useState(false)
  const [pickingNative, setPickingNative] = useState(false)
  const [addProjectError, setAddProjectError] = useState('')
  // server-side folder browser behind “+ Add project” — the browser can't hand us a
  // real filesystem path, so the daemon lists directories and the user walks to one
  const [picker, setPicker] = useState<{ path: string; parent: string | null; dirs: { name: string; path: string }[] } | null>(null)
  const [confirmDeleteBoard, setConfirmDeleteBoard] = useState<{ id: number; name: string } | null>(null)
  const [navigation, setNavigation] = useState(() => resolveLocationNavigation(
    localStorage.getItem('orchestra-view'), localStorage.getItem('orchestra-board-tab'), location.search))
  const { view, boardTab } = navigation
  const pickView = (next: PrimaryView) => {
    setNavigation((current) => ({ ...current, view: next }))
    const params = new URLSearchParams(location.search)
    for (const key of ['board', 'card', 'agent', 'conversation', 'session', 'job',
      'workspace', 'process', 'event']) params.delete(key)
    params.set('view', next)
    const query = params.toString()
    const href = `${location.pathname}${query ? `?${query}` : ''}${location.hash}`
    history.pushState(history.state, '', href)
    setLocationSearch(query ? `?${query}` : '')
  }
  const pickBoardTab = (next: BoardTab) => {
    setNavigation({ view: 'board', boardTab: next })
    const params = new URLSearchParams(location.search)
    for (const key of ['card', 'agent', 'conversation', 'session', 'job',
      'workspace', 'process', 'event', 'review', 'attention', 'approval',
      'question', 'conflict']) params.delete(key)
    params.set('view', 'board')
    const query = params.toString()
    const href = `${location.pathname}${query ? `?${query}` : ''}${location.hash}`
    history.pushState(history.state, '', href)
    setLocationSearch(query ? `?${query}` : '')
  }
  const pick = (f: number | 'all') => {
    setFocus(f)
    setMenuOpen(false)
    localStorage.setItem('orchestra-focus', String(f))
    const params = new URLSearchParams(location.search)
    for (const key of ['card', 'agent', 'conversation', 'session', 'job',
      'workspace', 'process', 'event', 'review', 'attention', 'approval',
      'question', 'conflict']) params.delete(key)
    params.set('view', view)
    if (f === 'all') params.delete('board')
    else params.set('board', String(f))
    const query = params.toString()
    const href = `${location.pathname}${query ? `?${query}` : ''}${location.hash}`
    history.pushState(history.state, '', href)
    setLocationSearch(new URL(href, location.origin).search)
  }

  const browseDirs = async (target?: string) => {
    setAddProjectError('')
    try {
      const listing = await api('GET', `/fs/dirs${target ? `?path=${encodeURIComponent(target)}` : ''}`)
      setPicker(listing)
    } catch (e) {
      setAddProjectError(e instanceof ApiError ? e.message : 'Could not read that folder')
    }
  }
  const addProject = async (project_path: string): Promise<string | null> => {
    try {
      const board = await api('POST', '/boards/resolve', { project_path, create: true })
      setAddingProject(false)
      setPicker(null)
      setAddProjectError('')
      refresh()
      pick(board.id)
      return null
    } catch (e) {
      const message = e instanceof ApiError ? e.message : 'Could not add project'
      setAddProjectError(message)
      return message
    }
  }
  const openAddProject = async () => {
    setAddProjectError('')
    // the daemon can open the native Finder chooser on its own display — offered
    // only to local browsers; remote clients and other platforms get 409 and the
    // in-app walker below
    setPickingNative(true)
    let picked: { path: string | null; cancelled: boolean } | null = null
    try {
      picked = await api('POST', '/fs/pick-dir')
    } catch {
      picked = null
    } finally {
      setPickingNative(false)
    }
    if (picked?.cancelled) return
    if (picked?.path) {
      const failure = await addProject(picked.path)
      if (!failure) return
      // surface the resolve error in the walker panel, opened at the chosen folder
      setAddingProject(true)
      await browseDirs(picked.path)
      setAddProjectError(failure)
      return
    }
    setAddingProject(true)
    void browseDirs()
  }

  const [projectError, setProjectError] = useState('')
  const deleteProject = async (id: number) => {
    setConfirmDeleteBoard(null)
    setProjectError('')
    try {
      await api('DELETE', `/boards/${id}`)
      if (focus === id) pick('all')
    } catch (e) {
      setProjectError(e instanceof ApiError ? `Could not delete project: ${e.message}` : 'Could not delete project')
    }
    refresh()
  }

  useEffect(() => {
    localStorage.setItem('orchestra-view', view)
    localStorage.setItem('orchestra-board-tab', boardTab)
  }, [view, boardTab])

  // a notification tap lands on /?board=<id>[&card=<id>] — focus that board;
  // the card param is picked up by ProjectGrid once snapshots arrive
  useEffect(() => {
    const params = new URLSearchParams(location.search)
    const b = boardIdFromSearch(location.search)
    if (params.has('board')) {
      const normalized = b ?? 'all'
      setFocus(normalized)
      localStorage.setItem('orchestra-focus', String(normalized))
    }
    if (['attention', 'approval', 'question', 'conflict'].some((key) => params.has(key))) {
      setNavigation({ view: 'board', boardTab: 'workspace' })
      window.setTimeout(() => window.dispatchEvent(new Event('orchestra:open-attention')), 0)
    } else if (['agent', 'session', 'conversation', 'workspace'].some((key) => params.has(key))) {
      setNavigation({ view: 'board', boardTab: 'agents' })
    } else if (params.has('card') || params.has('job') || params.has('delivery') || params.has('review')) {
      setNavigation({ view: 'board', boardTab: 'overview' })
    }
  }, [])

  useEffect(() => {
    const restoreDeepLink = () => {
      const requested = resolveLocationNavigation(
        localStorage.getItem('orchestra-view'), localStorage.getItem('orchestra-board-tab'), location.search)
      setLocationSearch(location.search)
      setNavigation(requested)
      const b = boardIdFromSearch(location.search)
      if (b !== null) {
        setFocus(b)
        localStorage.setItem('orchestra-focus', String(b))
      }
    }
    window.addEventListener('popstate', restoreDeepLink)
    return () => window.removeEventListener('popstate', restoreDeepLink)
  }, [])

  // default to the first project (network view) rather than the all-projects grid
  useEffect(() => {
    if (focus === 'all' && !localStorage.getItem('orchestra-focus') && snaps[0]) pick(snaps[0].board.id)
  }, [snaps.length])

  const loadSnapshots = useCallback(async () => {
    const boards = await api('GET', '/boards')
    const all = await Promise.all(boards.map((b: any) => api('GET', `/boards/${b.id}/snapshot`)))
    return { all }
  }, [])

  useEffect(() => {
    if (needsAuth) return // no stream until the token is accepted
    // EventSource cannot carry the memory-only owner credential. Keep the stream for
    // tokenless loopback daemons and use authenticated REST polling after owner login.
    const authenticatedPolling = Boolean(getToken())
    const es = authenticatedPolling ? null : new EventSource(streamUrl())
    let pending: number | undefined
    let retry: number | undefined
    let disposed = false
    const controller = createSingleFlightRefresh({
      load: loadSnapshots,
      onSuccess: ({ all }) => {
        setSnaps(all)
        hasConnectedRef.current = true
        setConnectionState('live')
        setNeedsAuth(false)
      },
      onFailure: (reason) => {
        if (reason instanceof ApiError && reason.status === 401) setNeedsAuth(true)
        setConnectionState(hasConnectedRef.current ? 'stale' : 'offline')
      },
      onSettled: () => setLoaded(true),
      onCycle: ({ succeeded, queued }) => {
        if (!queued && retry === undefined && (authenticatedPolling || !succeeded)) {
          retry = window.setTimeout(() => {
            if (disposed) return
            retry = undefined
            controller.request()
          }, succeeded ? 5_000 : 1_000)
        }
      },
    })
    const requestRefresh = () => controller.request()
    refreshRequest.current = requestRefresh
    // Subscribe before the first snapshot. Once open, the refresh covers every event that
    // preceded it. Every reconnect refreshes again; failed snapshots retry until REST recovers.
    if (es) {
      es.onopen = () => {
        if (disposed) return
        if (retry !== undefined) {
          clearTimeout(retry)
          retry = undefined
        }
        requestRefresh()
      }
      es.onmessage = () => {
        if (disposed) return
        // debounce bursts of events into one refresh
        if (pending) return
        pending = window.setTimeout(() => {
          if (disposed) return
          pending = undefined
          requestRefresh()
        }, 300)
      }
      es.onerror = () => {
        if (!disposed) setConnectionState(hasConnectedRef.current ? 'stale' : 'offline')
      }
    }
    // Probe REST immediately so a restored tab session can reconnect without a dead one-second wait,
    // or an expired session can return 401 and present Login.
    const initialFallback = authenticatedPolling ? undefined : window.setTimeout(requestRefresh, 0)
    if (authenticatedPolling) requestRefresh()
    return () => {
      disposed = true
      controller.dispose()
      if (refreshRequest.current === requestRefresh) refreshRequest.current = () => {}
      es?.close()
      if (initialFallback !== undefined) clearTimeout(initialFallback)
      if (retry !== undefined) clearTimeout(retry)
      if (pending) clearTimeout(pending)
    }
  }, [loadSnapshots, needsAuth])

  const localOwnerSurface = resolveLocalOwnerSurface({
    needsAuth,
    hasConnected: hasConnectedRef.current,
    connectionState,
    loaded,
  })
  if (localOwnerSurface === 'login') {
    return <Login onSubmit={(token) => beginLocalOwnerAuthentication({
      token,
      acceptToken: setToken,
      markLoading: () => setLoaded(false),
      clearAuthenticationChallenge: () => setNeedsAuth(false),
    })} />
  }
  if (localOwnerSurface === 'connecting') return <LocalOwnerConnecting />
  if (localOwnerSurface === 'initial-offline') {
    return <LocalOwnerInitialOffline onRetry={() => {
      beginLocalOwnerRetry(() => setLoaded(false), refresh)
    }} />
  }
  const agents = snaps.flatMap((s) => s.agents.filter((a) => a.status !== 'gone'))
  const cards = snaps.flatMap((s) => s.cards)
  const focusScope = resolveProjectFocus(snaps, focus)
  const shown = [...focusScope.snapshots]

  return (
    <RemoteAccessProvider>
    <div className="app">
      <OfflineStateBanner />
      <DaemonDownOverlay />
      <header className="topbar">
        <div className="brand">
          <Mark />
          <div className="brand-picker">
            <button className="brand-btn" onClick={() => setMenuOpen((o) => !o)}>
              <span className="brand-title">{focus === 'all' ? 'All projects' : shown[0]?.board.name ?? 'Project unavailable'}</span>
              <span className="brand-caret">▾</span>
            </button>
            <p className="sub">
              {snaps.length} project{snaps.length === 1 ? '' : 's'} · {agents.length} agent{agents.length === 1 ? '' : 's'} active · {cards.length} card{cards.length === 1 ? '' : 's'}
            </p>
            {projectError && (
              <p className="brand-project-error" role="alert">
                {projectError}
                <button type="button" className="brand-project-error-dismiss" aria-label="Dismiss"
                  onClick={() => setProjectError('')}>×</button>
              </p>
            )}
            {menuOpen && (
              <div className="brand-menu">
                <button className={focus === 'all' ? 'brand-item active' : 'brand-item'} onClick={() => pick('all')}>All projects</button>
                {snaps.map((s) => (
                  <button key={s.board.id} className={focus === s.board.id ? 'brand-item active' : 'brand-item'}
                    onClick={() => pick(s.board.id)}>
                    {s.board.name}
                    <span className="brand-item-end">
                      <span className="brand-count">{s.agents.filter((a) => a.status !== 'gone').length}</span>
                      <span className="brand-item-del" role="button" tabIndex={0} aria-label={`Delete project ${s.board.name}`}
                        title="Delete project"
                        onClick={(e) => { e.stopPropagation(); setMenuOpen(false); setConfirmDeleteBoard({ id: s.board.id, name: s.board.name }) }}
                        onKeyDown={(e) => {
                          if (e.key !== 'Enter' && e.key !== ' ') return
                          e.preventDefault(); e.stopPropagation()
                          setMenuOpen(false); setConfirmDeleteBoard({ id: s.board.id, name: s.board.name })
                        }}>×</span>
                    </span>
                  </button>
                ))}
                {addingProject ? (
                  <div className="brand-add-picker">
                    <div className="brand-add-path" title={picker?.path ?? ''}>{picker?.path ?? 'Loading…'}</div>
                    <div className="brand-add-list">
                      {picker?.parent && (
                        <button type="button" className="brand-dir brand-dir-up"
                          onClick={() => browseDirs(picker.parent!)}>↑ ..</button>
                      )}
                      {picker?.dirs.map((dir) => (
                        <button key={dir.path} type="button" className="brand-dir"
                          onClick={() => browseDirs(dir.path)}>{dir.name}</button>
                      ))}
                      {picker && picker.dirs.length === 0 && <p className="brand-add-empty">No subfolders</p>}
                    </div>
                    {addProjectError && <p className="brand-add-error">{addProjectError}</p>}
                    <div className="brand-add-actions">
                      <button type="button" className="btn ghost"
                        onClick={() => { setAddingProject(false); setPicker(null); setAddProjectError('') }}>Cancel</button>
                      <button type="button" className="btn" disabled={!picker}
                        onClick={() => { if (picker) void addProject(picker.path) }}>Add this folder</button>
                    </div>
                  </div>
                ) : (
                  <button className="brand-item brand-add-toggle" disabled={pickingNative}
                    onClick={() => void openAddProject()}>{pickingNative ? 'Choosing folder…' : '+ Add project…'}</button>
                )}
              </div>
            )}
          </div>
        </div>
        <div className="topbar-actions">
          <SystemMeter boards={snaps.map((s) => s.board.id)} />
          <nav className="view-tabs">
            <button className={view === 'board' ? 'tab active' : 'tab'} onClick={() => pickView('board')}>Board</button>
            <button className={view === 'settings' ? 'tab active' : 'tab'} onClick={() => pickView('settings')}>Settings</button>
            <NeedsYou boards={shown.map((snapshot) => snapshot.board)} readOnly={connectionState !== 'live'}
              onOpen={(item) => { pick(item.board_id); pickBoardTab('workspace') }} />
            <PushBell />
          </nav>
        </div>
      </header>
      {view === 'board'
        ? loaded && focusScope.kind === 'missing'
          ? <StateMessage kind="error" title="Project not found"
              detail={`Project ${focusScope.projectId} is unavailable or was deleted. Choose another project from the project switcher.`} />
          : loaded && snaps.length === 0
            ? connectionState === 'offline'
              ? <StateMessage kind="offline" detail="The daemon could not be reached. Start Orchestra and retry; no empty project state is being inferred." />
              : <GettingStarted onSettings={() => pickView('settings')} />
            : <BoardSection tab={boardTab} snaps={shown} focused={focus !== 'all' && focusScope.kind === 'project'}
                openMessages={shown.reduce((sum, snapshot) => sum
                  + snapshot.threads.filter((thread) => needsAttention(thread, snapshot.board.id, inboxRead)).length, 0)}
                onTabChange={pickBoardTab} onChange={refresh} />
        : <React.Suspense fallback={<div className="os-view-loading" aria-label="Loading settings"><span /><span /><span /></div>}>
            <SettingsView />
          </React.Suspense>}
      <PhoneRemoteDock active={view === 'board' ? boardTab : 'overview'} onTab={(tab) => {
        pickBoardTab(tab)
      }} onAttention={() => window.dispatchEvent(new Event('orchestra:open-attention'))} />
      <ConfirmDialog open={confirmDeleteBoard !== null}
        title={`Delete project “${confirmDeleteBoard?.name ?? ''}”?`}
        body="Removes the project from Orchestra along with its agents, cards, mail, and history. The folder on disk is untouched. Starting an agent session in that folder will re-add it."
        onConfirm={() => { if (confirmDeleteBoard) void deleteProject(confirmDeleteBoard.id) }}
        onCancel={() => setConfirmDeleteBoard(null)} />
    </div>
    </RemoteAccessProvider>
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

function Login({ onSubmit }: { onSubmit: (session: string) => void }) {
  const [mode, setMode] = useState<'loading' | 'setup' | 'login'>('loading')
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let current = true
    localOwnerPasswordStatus()
      .then((status) => { if (current) setMode(status.password_set ? 'login' : 'setup') })
      .catch((reason) => { if (current) setError(reason instanceof Error ? reason.message : 'Sign-in is unavailable.') })
    return () => { current = false }
  }, [])

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (mode === 'loading' || busy) return
    if (mode === 'setup' && password !== confirmation) {
      setError('Passwords do not match.')
      return
    }
    setBusy(true)
    setError('')
    try {
      const result = await authenticateLocalOwnerPassword(mode, password)
      onSubmit(result.session)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Sign-in failed.')
      setBusy(false)
    }
  }

  const setup = mode === 'setup'
  return (
    <div className="empty-hero">
      <div className="empty-card">
        <Mark />
        <p className="login-kicker">Local dashboard</p>
        <h1>{mode === 'loading' ? 'Preparing sign-in' : setup ? 'Create your password' : 'Welcome back'}</h1>
        <p>{setup
          ? 'Choose the password you will use to open Orchestra on this computer.'
          : 'Enter your Orchestra password to open the board.'}</p>
        <form className="login-form" onSubmit={submit}>
          <label className="login-field">
            <span>Password</span>
            <input className="login-input" type="password" autoFocus disabled={mode === 'loading' || busy}
              autoComplete={setup ? 'new-password' : 'current-password'} value={password}
              onChange={(event) => setPassword(event.target.value)} />
          </label>
          {setup && (
            <label className="login-field">
              <span>Confirm password</span>
              <input className="login-input" type="password" disabled={busy} autoComplete="new-password"
                value={confirmation} onChange={(event) => setConfirmation(event.target.value)} />
            </label>
          )}
          {error && <p className="login-error" role="alert">{error}</p>}
          <button className="login-btn" type="submit"
            disabled={mode === 'loading' || busy || password.length < 8 || (setup && confirmation.length < 8)}>
            {busy ? 'Checking…' : setup ? 'Create password' : 'Unlock board'}
          </button>
        </form>
        <p className="hint">The password stays on this computer. This tab stays signed in through refreshes for up to 12 hours and signs out when it closes.</p>
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
  const [selectedId, setSelectedId] = useState<string | null>(() => localStorage.getItem('orchestra-usage-provider'))
  const active = selectedUsageProvider(providers, selectedId)
  const highest = highestSubscriptionUsage(active ? [active] : [])
  const select = (id: string) => {
    setSelectedId(id)
    localStorage.setItem('orchestra-usage-provider', id)
  }
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
        aria-label="AI subscription usage" title={active ? `${active.name} subscription usage` : undefined}>
        <span className="meter-label">{active ? active.name.toLowerCase() : 'usage'}</span>
        <span className="meter-val">{highest === null ? '—' : `${Math.round(highest)}%`}</span>
        <span className="usage-caret" aria-hidden="true">⌄</span>
      </summary>
      <div className="usage-popover" role="dialog" aria-label="AI subscription usage details">
        <div className="usage-popover-head">
          <strong>Subscription usage</strong>
          <span>Live provider limits</span>
        </div>
        {/* one tab per signed-in plan — the meter above follows whichever is selected (#152) */}
        {providers.length > 1 && (
          <div className="usage-tabs" role="tablist" aria-label="Plans">
            {providers.map((provider) => (
              <button key={provider.id} type="button" role="tab" aria-selected={provider.id === active?.id}
                className={`usage-tab${provider.id === active?.id ? ' is-active' : ''}`}
                onClick={() => select(provider.id)}>{provider.name}</button>
            ))}
          </div>
        )}
        {active ? renderProvider(active) : (
          <p className="usage-empty">No subscription usage is available.</p>
        )}
      </div>
    </details>
  )
}

function SystemMeter({ boards }: { boards: number[] }) {
  const [sys, setSys] = useState<SystemInfo | null>(null)
  const loadSys = useCallback(() => api('GET', '/system').then(setSys).catch(() => {}), [])
  useEffect(() => {
    loadSys()
    const t = setInterval(loadSys, 60_000)
    return () => clearInterval(t)
  }, [loadSys])
  if (!sys) return null
  return (
    <div className="sysmeter">
      <span className="meter" title={`${sys.hired} hired agents running — this machine (${sys.hardware.cores} cores, ${sys.hardware.total_gb}GB) can comfortably run about ${sys.hardware.capacity}`}>
        <span className="meter-label">agents</span>
        <span className="meter-val">{sys.hired}/{sys.hardware.capacity}</span>
      </span>
      <WakeButton boards={boards} sys={sys} reload={loadSys} />
      <SubscriptionUsage sys={sys} />
      {/* per-session token detail lives in each agent's chat footer — the
          dashboard header stays free of token counts (operator request, #121) */}
    </div>
  )
}
