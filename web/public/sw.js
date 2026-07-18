// Orchestra service worker — cached app shell, network-first for the API.
importScripts('/sw-push.js') // push + notificationclick handlers (card #20)
const SHELL_CACHE = 'orchestra-shell-v1'
const API_CACHE = 'orchestra-api-v1'
const SHELL = ['/', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png']

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL_CACHE && k !== API_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url)
  if (url.origin !== location.origin || e.request.method !== 'GET') return
  if (url.pathname.startsWith('/api/')) {
    if (url.pathname.endsWith('/events')) return // SSE — never intercept
    // network-first: live data when online, last snapshot when not
    e.respondWith(
      fetch(e.request).then((res) => {
        if (res.ok) {
          const copy = res.clone()
          caches.open(API_CACHE).then((c) => c.put(e.request, copy))
        }
        return res
      }).catch(() => caches.match(e.request).then((hit) => hit ?? Response.error()))
    )
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
