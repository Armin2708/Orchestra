import { lookup } from 'node:dns'
import { Agent } from 'node:https'
import { BlockList, type LookupFunction } from 'node:net'

const PUSH_HOSTS = new Set([
  'fcm.googleapis.com',
  'updates.push.services.mozilla.com',
])

const PUSH_HOST_SUFFIXES = [
  '.push.apple.com',
  '.push.services.mozilla.com',
  '.notify.windows.com',
] as const

const blocked = new BlockList()
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(address, prefix, 'ipv4')
for (const [address, prefix] of [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['64:ff9b:1::', 48],
  ['100::', 64], ['2001:db8::', 32], ['2001:10::', 28], ['fc00::', 7],
  ['fe80::', 10], ['ff00::', 8],
] as const) blocked.addSubnet(address, prefix, 'ipv6')

const mappedIpv4 = (address: string): string | undefined => {
  const match = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/iu.exec(address)
  return match?.[1]
}

export const isPublicWebPushAddress = (address: string, family: number): boolean => {
  const mapped = mappedIpv4(address)
  if (mapped) return !blocked.check(mapped, 'ipv4')
  if (family === 4) return !blocked.check(address, 'ipv4')
  if (family === 6) return !blocked.check(address, 'ipv6')
  return false
}

const approvedPushHost = (hostname: string): boolean => PUSH_HOSTS.has(hostname)
  || PUSH_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix)
    && hostname.length > suffix.length)

/** Restricts device-provided endpoints to known browser push services and canonical HTTPS. */
export function validateWebPushEndpoint(value: string): string {
  const parsed = new URL(value)
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/u, '')
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password
    || (parsed.port && parsed.port !== '443') || parsed.hash || !approvedPushHost(hostname)) {
    throw new Error('push endpoint is not an approved Web Push service')
  }
  parsed.hostname = hostname
  return parsed.toString()
}

const safeLookup: LookupFunction = (hostname, options, callback) => {
  lookup(hostname, {
    family: options.family,
    hints: options.hints,
    all: true,
    verbatim: true,
  }, (error, addresses) => {
    if (error) return callback(error, '', 0)
    const approved = addresses.filter(({ address, family }) =>
      isPublicWebPushAddress(address, family))
    if (approved.length !== addresses.length || approved.length === 0) {
      const denied = new Error('Web Push DNS resolved to a prohibited address') as NodeJS.ErrnoException
      denied.code = 'EACCES'
      return callback(denied, '', 0)
    }
    if (options.all) return callback(null, approved)
    const selected = approved[0]!
    return callback(null, selected.address, selected.family)
  })
}

/** The request uses this lookup directly, closing the DNS-check-to-connect rebinding gap. */
export const createWebPushEgressAgent = (): Agent => new Agent({
  keepAlive: false,
  lookup: safeLookup,
  maxCachedSessions: 0,
})
