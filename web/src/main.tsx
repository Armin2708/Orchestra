import React, { useCallback, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { prepareBrowserAuthority, type BrowserAuthorityMode } from './deviceAuth'
import { PairingRequired } from './RemoteDeviceShell'

// Re-deriving the authority mode in place (instead of location.reload()) keeps
// sign-in from re-fetching the whole app shell through the tunnel.
function Root() {
  const [mode, setMode] = useState<BrowserAuthorityMode | null>(null)
  const [bootError, setBootError] = useState<string | null>(null)
  const refreshAuthority = useCallback(async () => {
    try {
      setMode(await prepareBrowserAuthority())
      setBootError(null)
    } catch (cause) {
      setBootError(cause instanceof Error ? cause.message : 'Device pairing failed.')
    }
  }, [])
  useEffect(() => { void refreshAuthority() }, [refreshAuthority])
  if (bootError) return <PairingRequired error={bootError} onSignedIn={() => void refreshAuthority()} />
  if (!mode) return null
  return <App authorityMode={mode} onAuthorityChanged={() => void refreshAuthority()} />
}

// The local board's entry. It authenticates this browser to the local daemon and
// nothing else — no Clerk, no hub. The shared cloud workspace is a separate bundle
// (cloud-main.tsx); keeping them apart means the daemon can never be handed a build
// that waits on a remote sign-in script its own CSP forbids.
createRoot(document.getElementById('root')!).render(<Root />)

// dev builds skip the worker so vite's module graph is never cached
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => {}) })
}