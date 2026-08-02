// Orchestra service worker — installable shell with authenticated data kept network-only.
importScripts('/sw-push.js') // push + notificationclick handlers (card #20)
const SHELL_CACHE = 'orchestra-shell-v3'
const SHELL = ['/', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png']
const isApiCache = (key) => key.startsWith('orchestra-api-')

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== SHELL_CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('message', (e) => {
  if (e.data?.type !== 'PURGE_DEVICE_DATA') return
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys
    .filter((key) => isApiCache(key) || key.startsWith('orchestra-shell-'))
    .map((key) => caches.delete(key)))))
})

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url)
  // Mutation requests always go directly to the network. There is deliberately no
  // Background Sync, outbox, retry, or replay path for remote authority.
  if (url.origin !== location.origin || e.request.method !== 'GET') return
  if (url.pathname.startsWith('/api/')) {
    if (url.pathname.endsWith('/events')) return // SSE — never intercept
    // Authenticated API responses are never persisted in a shared browser cache.
    // Offline reads fail explicitly; the rendered client may retain only its in-memory view.
    e.respondWith(fetch(e.request, { cache: 'no-store' }))
    return
  }
  if (e.request.mode === 'navigate') {
    // network-first so deploys land immediately; shell fallback offline
    e.respondWith(
      fetch(e.request).then((res) => {
        const copy = res.clone()
        caches.open(SHELL_CACHE).then((c) => c.put('/', copy))
        return res
      }).catch(() => caches.match('/'))
    )
    return
  }
  // static assets (hashed filenames) — cache-first
  e.respondWith(
    caches.match(e.request).then((hit) => hit ?? fetch(e.request).then((res) => {
      if (res.ok) {
        const copy = res.clone()
        caches.open(SHELL_CACHE).then((c) => c.put(e.request, copy))
      }
      return res
    }))
  )
})
