import { describe, expect, it } from 'vitest'
import {
  isPublicWebPushAddress,
  validateWebPushEndpoint,
} from '../src/web-push-security.js'

describe('Web Push outbound security boundary', () => {
  it('accepts canonical endpoints for supported browser push services', () => {
    for (const endpoint of [
      'https://fcm.googleapis.com/fcm/send/token',
      'https://updates.push.services.mozilla.com/wpush/v2/token',
      'https://web.push.apple.com/QH/token',
      'https://wns2-am3p.notify.windows.com/w/?token=opaque',
    ]) expect(validateWebPushEndpoint(endpoint)).toBe(endpoint)
  })

  it('rejects untrusted hosts, credentials, alternate ports and fragments', () => {
    for (const endpoint of [
      'https://example.test/push',
      'https://127.0.0.1/push',
      'https://fcm.googleapis.com:444/push',
      'https://user@fcm.googleapis.com/push',
      'https://fcm.googleapis.com/push#fragment',
      'http://fcm.googleapis.com/push',
    ]) expect(() => validateWebPushEndpoint(endpoint)).toThrow(/approved Web Push service/)
  })

  it('denies private, loopback, link-local, metadata, documentation and mapped addresses', () => {
    for (const [address, family] of [
      ['0.0.0.0', 4], ['10.1.2.3', 4], ['100.64.1.1', 4], ['127.0.0.1', 4],
      ['169.254.169.254', 4], ['172.31.1.1', 4], ['192.168.1.1', 4],
      ['192.0.2.1', 4], ['198.51.100.1', 4], ['203.0.113.1', 4],
      ['::', 6], ['::1', 6], ['fc00::1', 6], ['fe80::1', 6], ['2001:db8::1', 6],
      ['::ffff:127.0.0.1', 6], ['::ffff:169.254.169.254', 6],
    ] as const) expect(isPublicWebPushAddress(address, family), address).toBe(false)
    expect(isPublicWebPushAddress('8.8.8.8', 4)).toBe(true)
    expect(isPublicWebPushAddress('2606:4700:4700::1111', 6)).toBe(true)
  })
})
