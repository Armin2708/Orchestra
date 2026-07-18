import { api } from './api'

export const pushSupported = () =>
  'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window

// the PWA shell registers sw.js; before that ships, fall back to the push-only worker.
// registering a different script on the same scope later just updates the registration,
// so the subscription survives either order.
async function registration(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration()
  if (existing) return navigator.serviceWorker.ready
  await navigator.serviceWorker.register('/sw-push.js')
  return navigator.serviceWorker.ready
}

function vapidKeyBytes(base64url: string): Uint8Array {
  const pad = '='.repeat((4 - (base64url.length % 4)) % 4)
  const raw = atob((base64url + pad).replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(raw, (c) => c.charCodeAt(0))
}

export async function isSubscribed(): Promise<boolean> {
  if (!pushSupported()) return false
  const reg = await navigator.serviceWorker.getRegistration()
  return !!(await reg?.pushManager.getSubscription())
}

export async function subscribe(): Promise<void> {
  if (Notification.permission === 'denied')
    throw new Error('Notifications are blocked for this site — enable them in browser settings.')
  if ((await Notification.requestPermission()) !== 'granted')
    throw new Error('Notification permission not granted.')
  const { key } = await api('GET', '/push/vapid-key')
  const reg = await registration()
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: vapidKeyBytes(key) as BufferSource,
  })
  await api('POST', '/push/subscribe', sub.toJSON())
}

export async function unsubscribe(): Promise<void> {
  const reg = await navigator.serviceWorker.getRegistration()
  const sub = await reg?.pushManager.getSubscription()
  if (!sub) return
  // tell the daemon first — if the network drops after local unsubscribe, the
  // server would keep pushing into a dead endpoint until failure cleanup catches it
  await api('POST', '/push/unsubscribe', { endpoint: sub.endpoint })
  await sub.unsubscribe()
}
