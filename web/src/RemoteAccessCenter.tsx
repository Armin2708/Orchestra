import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { api, ApiError } from './api'
import {
  hasPendingDeviceAuthorityRecovery,
  recoverPendingDeviceAuthority,
  remoteMutationDigest,
  rotateDeviceAuthority,
} from './deviceAuth'
import { matchesDeviceRevokeGrant, REMOTE_SCOPES, type RemoteScope } from './remotePolicy'
import { useRemoteAccess } from './RemoteAccess'

type ManagedDevice = {
  id: string
  name: string
  scopes: RemoteScope[]
  state: string
  last_seen_at: string | null
  expires_at: string | null
  credential_expires_at: string | null
  current: boolean
}

type NotificationPreferences = {
  minimum_severity: 'info' | 'low' | 'medium' | 'high' | 'critical'
  quiet_start: string
  quiet_end: string
  preview: 'generic' | 'content'
}

type PendingStepUp = {
  id: string
  device_session_id: string
  operation: string
  resource_type: string
  resource_id: string
  request_digest: string
  issued_at: string
  expires_at: string
}

const defaultPreferences: NotificationPreferences = {
  minimum_severity: 'medium',
  quiet_start: '22:00',
  quiet_end: '07:00',
  preview: 'generic',
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? value as Record<string, unknown> : {}

const knownScopes = new Set<string>(REMOTE_SCOPES)
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window

const pushApplicationKey = (value: string): Uint8Array<ArrayBuffer> => {
  const normalized = value.replace(/-/gu, '+').replace(/_/gu, '/')
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0))
}

const subscribeDevicePush = async (): Promise<void> => {
  const bootstrap = asRecord(await api('GET', '/os/devices/self/push/vapid-key'))
  if (typeof bootstrap.key !== 'string') throw new Error('Device push bootstrap is unavailable.')
  const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' })
  const subscription = await registration.pushManager.getSubscription()
    ?? await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: pushApplicationKey(bootstrap.key),
    })
  const value = subscription.toJSON()
  await api('POST', '/os/devices/self/push/subscriptions', {
    endpoint: subscription.endpoint,
    keys: value.keys,
  })
}

const unsubscribeDevicePush = async (): Promise<void> => {
  const registration = await navigator.serviceWorker.getRegistration()
  const subscription = await registration?.pushManager.getSubscription()
  if (!subscription) return
  await api('DELETE', '/os/devices/self/push/subscriptions', { endpoint: subscription.endpoint })
  await subscription.unsubscribe()
}

export function normalizeManagedDevices(value: unknown, currentId?: string): ManagedDevice[] {
  const envelope = asRecord(value)
  const candidates = Array.isArray(value) ? value : Array.isArray(envelope.devices) ? envelope.devices : []
  return candidates.flatMap((candidate) => {
    const source = asRecord(candidate)
    const id = String(source.device_session_id ?? source.id ?? '')
    if (!id) return []
    let scopeInput: unknown[] = Array.isArray(source.scopes) ? source.scopes : []
    if (!scopeInput.length && typeof source.scopes === 'string') {
      try {
        const parsed = JSON.parse(source.scopes)
        scopeInput = Array.isArray(parsed) ? parsed : []
      } catch { scopeInput = source.scopes.split(',') }
    }
    const scopes = scopeInput.map(String).filter((scope): scope is RemoteScope => knownScopes.has(scope))
    return [{
      id,
      name: typeof source.name === 'string' && source.name.trim() ? source.name : 'Unnamed device',
      scopes,
      state: typeof source.state === 'string' ? source.state : source.revoked_at ? 'revoked' : 'active',
      last_seen_at: typeof source.last_seen_at === 'string' ? source.last_seen_at : null,
      expires_at: typeof source.expires_at === 'string' ? source.expires_at : null,
      credential_expires_at: typeof source.credential_expires_at === 'string' ? source.credential_expires_at : null,
      current: Boolean(source.current) || id === currentId,
    }]
  })
}

const dateLabel = (value: string | null): string => {
  if (!value) return 'not reported'
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? 'not reported' : parsed.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
}

const errorText = (cause: unknown): string => {
  if (!(cause instanceof Error)) return 'The remote access request failed.'
  try { return JSON.parse(cause.message).error ?? cause.message } catch { return cause.message }
}

export function RemoteAccessCenter({ remoteShell = false }: { remoteShell?: boolean }) {
  const access = useRemoteAccess()
  const [devices, setDevices] = useState<ManagedDevice[]>([])
  const [available, setAvailable] = useState(true)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [preferences, setPreferences] = useState<NotificationPreferences>(defaultPreferences)
  const [notificationState, setNotificationState] = useState<'unknown' | 'off' | 'on'>('unknown')
  const [tunnel, setTunnel] = useState<{ mode: 'private' | 'public' | 'local' | 'unknown'; origin?: string }>({ mode: 'unknown' })
  const [pendingRevoke, setPendingRevoke] = useState<{ deviceId: string; requestDigest: string; nonce: string } | null>(null)
  const [authorityRecovery, setAuthorityRecovery] = useState(false)
  const [pendingStepUps, setPendingStepUps] = useState<PendingStepUp[]>([])

  const load = useCallback(async () => {
    if (!navigator.onLine) { setLoading(false); return }
    setLoading(true)
    try {
      const [deviceResponse, notificationResponse, tunnelResponse, stepUpResponse] = await Promise.all([
        remoteShell && !access.hasScope('admin')
          ? Promise.resolve({ devices: [] })
          : api('GET', '/os/devices').catch(() => null),
        api('GET', '/os/devices/self/notifications').catch(() => null),
        api('GET', '/os/remote/status').catch(() => null),
        remoteShell ? Promise.resolve(null) : api('GET', '/os/devices/step-up/pending').catch(() => null),
      ])
      setDevices(normalizeManagedDevices(deviceResponse, access.session?.device_session_id))
      const notification = asRecord(notificationResponse)
      setPreferences({
        minimum_severity: ['info', 'low', 'medium', 'high', 'critical'].includes(String(notification.minimum_severity))
          ? notification.minimum_severity as NotificationPreferences['minimum_severity'] : defaultPreferences.minimum_severity,
        quiet_start: typeof notification.quiet_start === 'string' ? notification.quiet_start : defaultPreferences.quiet_start,
        quiet_end: typeof notification.quiet_end === 'string' ? notification.quiet_end : defaultPreferences.quiet_end,
        preview: notification.preview === 'content' ? 'content' : 'generic',
      })
      const remote = asRecord(tunnelResponse)
      const mode = remote.mode === 'private' || remote.mode === 'public' || remote.mode === 'local' ? remote.mode : 'unknown'
      setTunnel({ mode, origin: typeof remote.origin === 'string' ? remote.origin : undefined })
      const stepUps = asRecord(stepUpResponse).requests
      setPendingStepUps(Array.isArray(stepUps) ? stepUps.flatMap((candidate) => {
        const value = asRecord(candidate)
        const required = ['id', 'device_session_id', 'operation', 'resource_type', 'resource_id',
          'request_digest', 'issued_at', 'expires_at'] as const
        return required.every((key) => typeof value[key] === 'string')
          ? [Object.fromEntries(required.map((key) => [key, value[key]])) as unknown as PendingStepUp]
          : []
      }) : [])
      if (pushSupported()) {
        const registration = await navigator.serviceWorker.getRegistration()
        setNotificationState((await registration?.pushManager.getSubscription()) ? 'on' : 'off')
      }
      setAvailable(true)
      setError(null)
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 404) {
        setAvailable(false)
        setError(null)
      } else setError(errorText(cause))
    } finally {
      setLoading(false)
    }
  }, [access.hasScope, access.session?.device_session_id, remoteShell])

  useEffect(() => { void load() }, [load])
  useEffect(() => {
    if (!pendingRevoke || !access.session?.step_up) return
    if (!matchesDeviceRevokeGrant(
      access.session, pendingRevoke.deviceId, pendingRevoke.requestDigest, pendingRevoke.nonce,
    )) setPendingRevoke(null)
  }, [access.session, pendingRevoke])

  const activeDevices = useMemo(() => devices.filter((device) => device.state === 'active').length, [devices])

  const revoke = async (device: ManagedDevice) => {
    if (!access.online || device.current || busy) return
    const path = `/api/v1/os/devices/${encodeURIComponent(device.id)}/revoke`
    const requestDigest = await remoteMutationDigest({ method: 'POST', path, body: null })
    const pendingMatches = pendingRevoke?.deviceId === device.id && pendingRevoke.requestDigest === requestDigest
    const pendingNonce = pendingMatches ? pendingRevoke?.nonce ?? '' : ''
    if (access.isRemote && (!pendingMatches || !matchesDeviceRevokeGrant(
      access.session, device.id, requestDigest, pendingNonce,
    ))) {
      if (!access.hasScope('admin')) return
      setBusy(`step-up-revoke:${device.id}`)
      setError(null)
      try {
        const nonce = crypto.randomUUID()
        setPendingRevoke({ deviceId: device.id, requestDigest, nonce })
        await access.requestStepUp('admin', 'device', device.id, {
          operation: 'device.revoke', requestDigest, nonce,
        })
      } catch (cause) { setPendingRevoke(null); setError(errorText(cause)) }
      finally { setBusy(null) }
      return
    }
    if (!window.confirm(`Revoke ${device.name}? Only this device will lose credentials, streams, grants, push, and cached access.`)) return
    // Re-check immediately before the destructive request so an expiry at the
    // confirmation boundary cannot turn stale UI state into device administration.
    if (access.isRemote && (!pendingMatches || !matchesDeviceRevokeGrant(
      access.session, device.id, requestDigest, pendingNonce,
    ))) return
    setBusy(`revoke:${device.id}`)
    setError(null)
    try {
      const grant = access.session?.step_up
      const grantHeaders = access.isRemote && grant ? {
        'x-orchestra-step-up-grant': grant.id,
        'x-orchestra-step-up-nonce': grant.nonce,
      } : undefined
      await api('POST', `/os/devices/${encodeURIComponent(device.id)}/revoke`, undefined, grantHeaders)
      await load()
    } catch (cause) { setError(errorText(cause)) }
    finally { setPendingRevoke(null); setBusy(null) }
  }

  const rotateCurrentCredential = async () => {
    if (!access.online || busy || !access.isRemote) return
    setBusy('rotate')
    setError(null)
    try {
      await rotateDeviceAuthority()
      await access.refresh()
      await load()
    } catch (cause) {
      setAuthorityRecovery(hasPendingDeviceAuthorityRecovery())
      setError(errorText(cause))
    }
    finally { setBusy(null) }
  }

  const recoverAuthority = async () => {
    if (busy || !authorityRecovery) return
    setBusy('recover-authority')
    try {
      const recovered = await recoverPendingDeviceAuthority()
      setAuthorityRecovery(!recovered)
      if (recovered) { await access.refresh(); await load(); setError(null) }
    } catch (cause) { setError(errorText(cause)) }
    finally { setBusy(null) }
  }

  const toggleNotifications = async () => {
    if (!access.online || busy || !pushSupported()) return
    setBusy('push')
    setError(null)
    try {
      if (notificationState === 'on') {
        if (remoteShell) await unsubscribeDevicePush()
        else await (await import('./push')).unsubscribe()
        setNotificationState('off')
      } else {
        if (remoteShell) await subscribeDevicePush()
        else await (await import('./push')).subscribe()
        setNotificationState('on')
      }
    } catch (cause) { setError(errorText(cause)) }
    finally { setBusy(null) }
  }

  const saveNotifications = async () => {
    if (!access.online || busy) return
    setBusy('preferences')
    setError(null)
    try {
      await api('PUT', '/os/devices/self/notifications', preferences)
    } catch (cause) { setError(errorText(cause)) }
    finally { setBusy(null) }
  }

  const approveStepUp = async (requestId: string) => {
    if (!access.online || busy || remoteShell) return
    setBusy(`approve-step-up:${requestId}`)
    setError(null)
    try {
      await api('POST', `/os/devices/step-up/${encodeURIComponent(requestId)}/approve`)
      await load()
    } catch (cause) { setError(errorText(cause)) }
    finally { setBusy(null) }
  }

  return (
    <section className="remote-access-center" aria-labelledby="remote-access-title">
      <header className="remote-access-heading">
        <div>
          <p className="settings-kicker">Remote and mobile</p>
          <h2 id="remote-access-title">Device access</h2>
          <p>Named, scoped sessions only. Pairing and notifications never put the owner token in a URL, browser setting, log, referrer, analytics event, or push payload.</p>
        </div>
        <span className={`remote-connection-state ${access.online ? 'online' : 'offline'}`}>
          {access.online ? `${activeDevices} active device${activeDevices === 1 ? '' : 's'}` : 'Offline · read-only'}
        </span>
      </header>

      <div className={`remote-tunnel-posture ${tunnel.mode}`}>
        <strong>{tunnel.mode === 'private' ? 'Private tailnet connection'
          : tunnel.mode === 'public' ? 'Public tunnel exposed'
            : tunnel.mode === 'local' ? 'Local access only' : 'Private networking is the default'}</strong>
        <p>{tunnel.mode === 'public'
          ? 'Anyone can reach the public origin. Device authorization still applies; stop exposure when it is no longer needed.'
          : 'Prefer Tailscale or another private network. Public exposure requires explicit confirmation on the host and must never be an automatic fallback.'}</p>
        {tunnel.origin && <code>{tunnel.origin}</code>}
      </div>

      {error && <p className="remote-access-error" role="alert">{error}</p>}
      {authorityRecovery && <button type="button" className="remote-authority-recover"
        disabled={busy !== null} onClick={() => void recoverAuthority()}>
        {busy === 'recover-authority' ? 'Recovering…' : 'Recover credential storage'}
      </button>}
      {!available && !loading && (
        <div className="remote-access-unavailable" role="note">
          <strong>Secure DeviceSessions are not enabled on this daemon.</strong>
          <p>The legacy token preview is not safe device pairing. Keep access local or private until the remote security routes are enabled.</p>
        </div>
      )}

      {available && (
        <>
          {!remoteShell && pendingStepUps.length > 0 && <section className="remote-step-up-requests"
            aria-labelledby="remote-step-up-title">
            <h3 id="remote-step-up-title">Remote confirmations</h3>
            <p>Confirm the exact named device, action, target, and expiry on this trusted local screen.</p>
            {pendingStepUps.map((pending) => <article key={pending.id}>
              <strong>{pending.operation}</strong>
              <span>Device {pending.device_session_id}</span>
              <span>{pending.resource_type} {pending.resource_id}</span>
              <span>Expires {dateLabel(pending.expires_at)}</span>
              <code>{pending.request_digest}</code>
              <button type="button" disabled={!access.online || busy !== null}
                onClick={() => void approveStepUp(pending.id)}>
                {busy === `approve-step-up:${pending.id}` ? 'Confirming…' : 'Confirm exact action'}
              </button>
            </article>)}
          </section>}
          {(!remoteShell || access.hasScope('admin')) && <div className="remote-device-list" aria-busy={loading}>
            {loading && <p>Loading named devices…</p>}
            {!loading && devices.length === 0 && <p>No paired devices. Pair from the host using a single-use, expiring ticket.</p>}
            {devices.map((device) => {
              const canRevoke = access.canUse('admin', 'device', device.id)
              const hasAdmin = access.hasScope('admin')
              return <article className={`remote-device-card ${device.state}`} key={device.id}>
                <div className="remote-device-title">
                  <div><strong>{device.name}</strong>{device.current && <span>this device</span>}</div>
                  <em>{device.state}</em>
                </div>
                <dl>
                  <div><dt>Last seen</dt><dd>{dateLabel(device.last_seen_at)}</dd></div>
                  <div><dt>Session expiry</dt><dd>{dateLabel(device.expires_at)}</dd></div>
                  <div><dt>Credential expiry</dt><dd>{dateLabel(device.credential_expires_at)}</dd></div>
                </dl>
                <div className="remote-device-scopes" aria-label={`${device.name} scopes`}>
                  {device.scopes.map((scope) => <span key={scope}>{scope}</span>)}
                </div>
                <button type="button" className="remote-revoke"
                  disabled={device.current || !access.online || busy !== null || device.state !== 'active' || (access.isRemote && !hasAdmin)}
                  onClick={() => void revoke(device)}>
                  {device.current ? 'Use another trusted device to revoke'
                    : busy === `revoke:${device.id}` ? 'Revoking…'
                      : busy === `step-up-revoke:${device.id}` ? 'Requesting confirmation…'
                        : access.isRemote && !hasAdmin ? 'Admin scope required'
                          : !canRevoke ? 'Confirm revoke access'
                            : 'Revoke only this device'}
                </button>
                {device.current && access.isRemote && (
                  <button type="button" className="remote-rotate" disabled={!access.online || busy !== null}
                    onClick={() => void rotateCurrentCredential()}>
                    {busy === 'rotate' ? 'Rotating…' : 'Rotate credential and device key'}
                  </button>
                )}
              </article>
            })}
          </div>}

          <section className="remote-notification-settings" aria-labelledby="remote-notification-title">
            <div>
              <h3 id="remote-notification-title">Attention notifications</h3>
              <p>Device-bound alerts use generic lock-screen text by default and open only allowlisted same-origin targets.</p>
            </div>
            <button type="button" onClick={() => void toggleNotifications()}
              disabled={!pushSupported() || !access.online || busy !== null
                || (remoteShell && !access.hasScope('message'))}>
              {!pushSupported() ? 'Push unavailable' : busy === 'push' ? 'Updating…' : notificationState === 'on' ? 'Turn off on this device' : 'Turn on for this device'}
            </button>
            <label><span>Minimum severity</span>
              <select value={preferences.minimum_severity} disabled={!access.online || busy !== null
                || (remoteShell && !access.hasScope('message'))}
                onChange={(event) => setPreferences((current) => ({ ...current, minimum_severity: event.target.value as NotificationPreferences['minimum_severity'] }))}>
                {['info', 'low', 'medium', 'high', 'critical'].map((severity) => <option key={severity}>{severity}</option>)}
              </select>
            </label>
            <label><span>Quiet hours start</span><input type="time" value={preferences.quiet_start} disabled={!access.online || busy !== null
              || (remoteShell && !access.hasScope('message'))}
              onChange={(event) => setPreferences((current) => ({ ...current, quiet_start: event.target.value }))} /></label>
            <label><span>Quiet hours end</span><input type="time" value={preferences.quiet_end} disabled={!access.online || busy !== null
              || (remoteShell && !access.hasScope('message'))}
              onChange={(event) => setPreferences((current) => ({ ...current, quiet_end: event.target.value }))} /></label>
            <label><span>Lock-screen preview</span>
              <select value={preferences.preview} disabled={!access.online || busy !== null
                || (remoteShell && !access.hasScope('message'))}
                onChange={(event) => setPreferences((current) => ({ ...current, preview: event.target.value as NotificationPreferences['preview'] }))}>
                <option value="generic">Generic (recommended)</option><option value="content">Reveal content</option>
              </select>
            </label>
            <button type="button" className="remote-save-notifications"
              disabled={!access.online || busy !== null || (remoteShell && !access.hasScope('message'))}
              onClick={() => void saveNotifications()}>{busy === 'preferences' ? 'Saving…' : 'Save notification policy'}</button>
          </section>

          <section className="remote-install-guide">
            <h3>Install and reconnect</h3>
            <div><strong>iPhone / iPad</strong><p>Open in Safari, Share → Add to Home Screen. Push requires an installed web app. Reconnect stays read-only until this device session is verified.</p></div>
            <div><strong>Android</strong><p>Open in Chrome, Install app. If credentials expire or are revoked, cached authority is purged and a new one-time pairing is required.</p></div>
            <small>Orchestra never claims it can erase an unreachable lost phone. Revocation takes effect server-side immediately and purges app caches at the device’s next contact.</small>
          </section>
        </>
      )}
    </section>
  )
}
