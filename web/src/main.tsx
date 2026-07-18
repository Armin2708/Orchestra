import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { setToken } from './api'

// one-scan pairing: `orchestra remote` QRs the board URL with #token=…
// stored before render so the first fetch is already authenticated
const paired = location.hash.match(/[#&]token=([0-9a-f]{16,})/)
if (paired) {
  setToken(paired[1])
  history.replaceState(null, '', location.pathname + location.search)
}

createRoot(document.getElementById('root')!).render(<App />)

// dev builds skip the worker so vite's module graph is never cached
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => {}) })
}
