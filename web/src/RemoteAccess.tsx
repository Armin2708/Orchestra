import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { api, ApiError } from './api'
import {
  hasMatchingStepUp,
  hasRemoteScope,
  normalizeRemoteDeviceSession,
  remoteCanUse,
  type RemoteDeviceSession,
  type RemoteScope,
} from './remotePolicy'
import './remoteAccess.css'

type RemoteAccessState = {
  checking: boolean
  isRemote: boolean
  online: boolean
  // the daemon itself is unreachable (network failure or dead upstream) —
  // distinct from lacking a scope or step-up grant
  daemonDown: boolean
  session: RemoteDeviceSession | null
  error: string | null
  refresh: () => Promise<void>
  hasScope: (scope: RemoteScope) => boolean
  hasStepUp: (scope: RemoteScope, resourceType: string, resourceId: string) => boolean
  canUse: (scope: RemoteScope, resourceType?: string, resourceId?: string) => boolean
  requestStepUp: (
    scope: RemoteScope,
    resourceType: string,
    resourceId: string,
    action?: { operation: string; requestDigest: string; nonce: string },
  ) => Promise<void>
}

const localFallback: RemoteAccessState = {
  checking: true,
  isRemote: true,
  online: typeof navigator === 'undefined' || navigator.onLine,
  daemonDown: false,
  session: null,
  error: null,
  refresh: async () => {},
  hasScope: () => false,
  hasStepUp: () => false,
  canUse: () => false,
  requestStepUp: async () => {},
}

const RemoteAccessContext = createContext<RemoteAccessState>(localFallback)

const purgeDeviceCaches = () => {
  if (!('serviceWorker' in navigator)) return
  void navigator.serviceWorker.getRegistration().then((registration) => {
    registration?.active?.postMessage({ type: 'PURGE_DEVICE_DATA' })
  })
}

export function RemoteAccessProvider({ children }: { children: React.ReactNode }) {
  const [online, setOnline] = useState(() => navigator.onLine)
  const [checking, setChecking] = useState(true)
  const [isRemote, setIsRemote] = useState(true)
  const [session, setSession] = useState<RemoteDeviceSession | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [daemonDown, setDaemonDown] = useState(false)
  const [authorizationEpoch, setAuthorizationEpoch] = useState(0)

  const refresh = useCallback(async () => {
    if (!navigator.onLine) return
    let responded = false
    try {
      const response = await api('GET', '/os/devices/self')
      responded = true
      setDaemonDown(false)
      if (response?.local_owner === true) {
        setSession(null)
        setIsRemote(false)
        setError(null)
        return
      }
      const next = normalizeRemoteDeviceSession(response)
      if (!next) throw new Error('The daemon returned an invalid device session.')
      setSession(next)
      setIsRemote(true)
      setError(null)
    } catch (cause) {
      // an ApiError means the daemon (or its proxy) answered; anything else is a
      // dead socket. 502/503/504 are a live proxy in front of a dead daemon.
      setDaemonDown(!responded && (!(cause instanceof ApiError)
        || cause.status === 502 || cause.status === 503 || cause.status === 504))
      if (cause instanceof ApiError && cause.status === 404) {
        setSession(null)
        setIsRemote(true)
        setError('Remote authority is unavailable on this daemon; controls remain view-only.')
      } else {
        setSession(null)
        setIsRemote(true)
        setError(cause instanceof Error ? cause.message : 'Device authority could not be verified.')
        if (cause instanceof ApiError && (cause.status === 401 || cause.status === 403)) purgeDeviceCaches()
      }
    } finally {
      setChecking(false)
    }
  }, [])

  useEffect(() => {
    const onOnline = () => { setOnline(true); void refresh() }
    const onOffline = () => setOnline(false)
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
    void refresh()
    const timer = window.setInterval(() => { if (navigator.onLine) void refresh() }, 30_000)
    return () => {
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
      window.clearInterval(timer)
    }
  }, [refresh])

  useEffect(() => {
    if (!daemonDown) return
    const timer = window.setInterval(() => { if (navigator.onLine) void refresh() }, 5_000)
    return () => window.clearInterval(timer)
  }, [daemonDown, refresh])

  useEffect(() => {
    if (!session) return
    const deadlines = [session.expires_at, session.credential_expires_at, session.step_up?.active_until]
      .map((value) => Date.parse(value ?? ''))
      .filter(Number.isFinite)
    const deadline = deadlines.length ? Math.min(...deadlines) : Number.NaN
    const timer = Number.isFinite(deadline) && deadline > Date.now()
      ? window.setTimeout(() => setAuthorizationEpoch((value) => value + 1), Math.min(deadline - Date.now() + 1, 2_147_483_647))
      : undefined
    const onVisibility = () => {
      if (document.visibilityState === 'visible') setAuthorizationEpoch((value) => value + 1)
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      if (timer !== undefined) window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [session])

  const hasScope = useCallback((scope: RemoteScope) =>
    !isRemote || hasRemoteScope(session, scope), [authorizationEpoch, isRemote, session])
  const canUse = useCallback((scope: RemoteScope, resourceType?: string, resourceId?: string) =>
    !isRemote || remoteCanUse(session, online, scope, resourceType, resourceId), [authorizationEpoch, isRemote, online, session])
  const hasStepUp = useCallback((scope: RemoteScope, resourceType: string, resourceId: string) =>
    !isRemote || Boolean(session && hasMatchingStepUp(session, scope, resourceType, resourceId)), [authorizationEpoch, isRemote, session])
  const requestStepUp = useCallback(async (
    scope: RemoteScope,
    resourceType: string,
    resourceId: string,
    action?: { operation: string; requestDigest: string; nonce: string },
  ) => {
    if (!online || !isRemote || !hasRemoteScope(session, scope)) return
    if (!action) throw new Error('This control has no exact action-bound step-up contract.')
    await api('POST', '/os/devices/self/step-up', {
      operation: action.operation,
      resource_type: resourceType,
      resource_id: resourceId,
      request_digest: action.requestDigest,
      nonce: action.nonce,
    })
    await refresh()
  }, [isRemote, online, refresh, session])

  const value = useMemo<RemoteAccessState>(() => ({
    checking, isRemote, online, daemonDown, session, error, refresh, hasScope, hasStepUp, canUse, requestStepUp,
  }), [checking, isRemote, online, daemonDown, session, error, refresh, hasScope, hasStepUp, canUse, requestStepUp])

  return <RemoteAccessContext.Provider value={value}>{children}</RemoteAccessContext.Provider>
}

export const useRemoteAccess = () => useContext(RemoteAccessContext)

/** Full-viewport blur over the board while the daemon is unreachable. */
export function DaemonDownOverlay() {
  const access = useRemoteAccess()
  const [busy, setBusy] = useState(false)
  if (access.checking || !access.daemonDown || !access.online) return null
  const retry = async () => {
    setBusy(true)
    try { await access.refresh() } finally { setBusy(false) }
  }
  return (
    <div className="daemon-down-overlay" role="alertdialog" aria-modal="true" aria-labelledby="daemon-down-title">
      <div className="daemon-down-card">
        <span className="daemon-down-sign" aria-hidden="true">⚠</span>
        <strong id="daemon-down-title">Daemon unreachable</strong>
        <p>The Orchestra daemon is not responding. The board behind this notice is frozen and may be stale — this is not a permissions problem.</p>
        <p className="daemon-down-hint">Start it with <code>orchestra</code> in a terminal; this screen clears on its own once it answers (checking every 5 seconds).</p>
        <button type="button" disabled={busy} onClick={() => void retry()}>
          {busy ? 'Checking…' : 'Retry now'}
        </button>
      </div>
    </div>
  )
}

export function OfflineStateBanner() {
  const access = useRemoteAccess()
  if (access.online) return null
  return (
    <div className="remote-offline-banner" role="status" aria-live="polite">
      <strong>Offline · read-only</strong>
      <span>Live state may be stale. Messages, approvals, controls, and terminal input are disabled and will not be queued.</span>
    </div>
  )
}

export function RemoteControlGate({
  scope,
  resourceType,
  resourceId,
  label,
}: {
  scope: 'agent-control' | 'terminal-write' | 'admin'
  resourceType: string
  resourceId: string
  label: string
}) {
  const access = useRemoteAccess()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  // an unreachable daemon is not a permission problem — DaemonDownOverlay owns that state
  if (access.daemonDown) return null
  if (!access.isRemote || access.canUse(scope, resourceType, resourceId)) return null
  const request = async () => {
    setBusy(true)
    setMessage(null)
    try {
      await access.requestStepUp(scope, resourceType, resourceId)
      setMessage('Confirmation requested. Control stays locked until the daemon returns a matching active grant.')
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'Step-up could not be requested.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="remote-control-gate" role="note">
      <span><strong>View-only</strong>{label}</span>
      <button type="button" disabled={busy || !access.online || !access.hasScope(scope)} onClick={() => void request()}>
        {busy ? 'Requesting…' : access.hasScope(scope) ? 'Request control' : `${scope} not granted`}
      </button>
      {message && <small role="status">{message}</small>}
    </div>
  )
}
