import React from 'react'

export type LocalOwnerConnectionState = 'live' | 'stale' | 'offline'
export type LocalOwnerSurface = 'login' | 'connecting' | 'application'

export const resolveLocalOwnerSurface = ({
  needsAuth,
  hasConnected,
  connectionState,
}: {
  needsAuth: boolean
  hasConnected: boolean
  connectionState: LocalOwnerConnectionState
}): LocalOwnerSurface => {
  if (needsAuth) return 'login'
  if (!hasConnected && connectionState !== 'live') return 'connecting'
  return 'application'
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
