// Orchestra push handlers — imported by sw.js (importScripts) once the PWA shell
// lands; until then web/src/push.ts registers this file directly as the worker.
const NOTIFICATION_KEYS = new Set([
  'board', 'card', 'agent', 'session', 'conversation', 'workspace',
  'attention', 'approval', 'question', 'review', 'conflict',
])
const NOTIFICATION_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

function safeNotificationPath(value) {
  if (typeof value !== 'string' || !value.trim()) return '/'
  try {
    const parsed = new URL(value, self.location.origin)
    if (parsed.origin !== self.location.origin || parsed.pathname !== '/') return '/'
    const safe = new URLSearchParams()
    for (const [key, item] of parsed.searchParams) {
      if (NOTIFICATION_KEYS.has(key) && NOTIFICATION_IDENTIFIER.test(item)) safe.append(key, item)
    }
    const query = safe.toString()
    return query ? `/?${query}` : '/'
  } catch { return '/' }
}

self.addEventListener('push', (e) => {
  let d = {}
  try { d = e.data.json() } catch { /* non-JSON push — show something anyway */ }
  if (d.suppressed === true) return
  const reveal = d.preview === 'content'
  e.waitUntil(self.registration.showNotification(reveal ? String(d.title ?? 'Orchestra') : 'Orchestra needs your attention', {
    body: reveal ? String(d.body ?? '') : 'Open Orchestra to review an update.',
    tag: d.tag, // same card collapses into one notification instead of stacking
    data: { url: safeNotificationPath(d.url) },
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
  }))
})

self.addEventListener('notificationclick', (e) => {
  e.notification.close()
  const url = safeNotificationPath(e.notification.data?.url)
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
    // reuse an open board tab: navigate it to the card and bring it forward
    for (const w of wins) {
      if (new URL(w.url).origin === self.location.origin) {
        w.navigate(url)
        return w.focus()
      }
    }
    return self.clients.openWindow(url)
  }))
})
