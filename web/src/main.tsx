import { ClerkProvider } from '@clerk/react'
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

// Clerk identifies the human operating the browser. It is deliberately separate from
// the device/authority pairing above, which authenticates this browser to the local
// daemon; hub mode needs both — a person and a trusted device.
const clerkPublishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined

function Bootstrap() {
  // Without a key the local single-machine app must still boot: hub sign-in is
  // additive, and an unconfigured key must never take the board offline.
  if (!clerkPublishableKey) return <Root />
  return (
    <ClerkProvider publishableKey={clerkPublishableKey} afterSignOutUrl="/">
      <Root />
    </ClerkProvider>
  )
}

createRoot(document.getElementById('root')!).render(<Bootstrap />)

// dev builds skip the worker so vite's module graph is never cached
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => {}) })
}