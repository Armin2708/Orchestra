import React from 'react'

export type LocalOwnerConnectionState = 'live' | 'stale' | 'offline'
export type LocalOwnerSurface = 'login' | 'connecting' | 'initial-offline' | 'application'

export const resolveLocalOwnerSurface = ({
  needsAuth,
  hasConnected,
  connectionState,
  loaded,
}: {
  needsAuth: boolean
  hasConnected: boolean
  connectionState: LocalOwnerConnectionState
  loaded: boolean
}): LocalOwnerSurface => {
  if (needsAuth) return 'login'
  if (!hasConnected && connectionState !== 'live') return loaded ? 'initial-offline' : 'connecting'
  return 'application'
}

export const beginLocalOwnerRetry = (
  markLoading: () => void,
  requestRefresh: () => void,
) => {
  markLoading()
  requestRefresh()
}

export const beginLocalOwnerAuthentication = ({
  token,
  acceptToken,
  markLoading,
  clearAuthenticationChallenge,
}: {
  token: string
  acceptToken: (token: string) => void
  markLoading: () => void
  clearAuthenticationChallenge: () => void
}) => {
  acceptToken(token)
  markLoading()
  clearAuthenticationChallenge()
}

export function LocalOwnerConnecting() {
  return (
    <main className="empty-hero" aria-busy="true">
      <section className="empty-card" role="status" aria-live="polite" aria-atomic="true">
        <h1>Connecting to Orchestra</h1>
        <p>Loading authenticated project data…</p>
        <p className="hint">The command center will open when its first verified snapshot is ready.</p>
      </section>
    </main>
  )
}

export function LocalOwnerInitialOffline({ onRetry }: { onRetry: () => void }) {
  return (
    <main className="empty-hero">
      <section className="empty-card" role="alert" aria-live="assertive" aria-atomic="true">
        <h1>Orchestra is unavailable</h1>
        <p>Authenticated project data could not be loaded. Orchestra will keep retrying automatically.</p>
        <button className="login-btn" type="button" onClick={onRetry}>Retry now</button>
        <p className="hint">No command-center or device controls are mounted until the first verified snapshot is ready.</p>
      </section>
    </main>
  )
}
