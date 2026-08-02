import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { prepareBrowserAuthority } from './deviceAuth'
import { PairingRequired } from './RemoteDeviceShell'

async function boot() {
  try {
    const authorityMode = await prepareBrowserAuthority()
    createRoot(document.getElementById('root')!).render(<App authorityMode={authorityMode} />)
  } catch (cause) {
    const error = cause instanceof Error ? cause.message : 'Device pairing failed.'
    createRoot(document.getElementById('root')!).render(<PairingRequired error={error} />)
  }
}

void boot()

// dev builds skip the worker so vite's module graph is never cached
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => {}) })
}
