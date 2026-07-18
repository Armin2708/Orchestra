// Orchestra push handlers — imported by sw.js (importScripts) once the PWA shell
// lands; until then web/src/push.ts registers this file directly as the worker.
self.addEventListener('push', (e) => {
  let d = {}
  try { d = e.data.json() } catch { /* non-JSON push — show something anyway */ }
  e.waitUntil(self.registration.showNotification(d.title ?? 'Orchestra', {
    body: d.body ?? '',
    tag: d.tag, // same card collapses into one notification instead of stacking
    data: { url: d.url ?? '/' },
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
  }))
})

self.addEventListener('notificationclick', (e) => {
  e.notification.close()
  const url = e.notification.data?.url ?? '/'
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
