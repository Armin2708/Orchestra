import { createHash, timingSafeEqual } from 'node:crypto'
import type { RemoteRateLimitFamily } from './remote-authorization-policy.js'

export type RemoteCredentialTransport =
  | 'authorization-header'
  | 'proof-bound-header'
  | 'cookie'
  | 'stream-ticket-query'

export interface RemoteRequestContextPolicy {
  expectedHosts: readonly string[]
  expectedOrigins: readonly string[]
  trustedProxyAddresses: readonly string[]
  trustForwardedHost: boolean
}

export interface RemoteRequestContextInput {
  method: string
  host?: string
  forwardedHost?: string
  origin?: string
  secFetchSite?: string
  remoteAddress: string
  clientKind: 'browser' | 'non-browser'
  credentialTransport: RemoteCredentialTransport
  requestPurpose: 'api' | 'stream'
  csrfCookie?: string
  csrfHeader?: string
}

export type RemoteRequestContextDenialCode =
  | 'host_missing'
  | 'host_invalid'
  | 'host_untrusted'
  | 'forwarded_host_untrusted'
  | 'origin_missing'
  | 'origin_invalid'
  | 'origin_untrusted'
  | 'fetch_metadata_missing'
  | 'cross_site_request'
  | 'csrf_token_missing'
  | 'csrf_token_mismatch'
  | 'query_credential_forbidden'

export type RemoteRequestContextDecision =
  | {
    allowed: true
    effectiveHost: string
    normalizedOrigin: string | null
    stateChanging: boolean
    credentialTransport: RemoteCredentialTransport
  }
  | {
    allowed: false
    code: RemoteRequestContextDenialCode
    stage: 'request-context'
  }

const deny = (code: RemoteRequestContextDenialCode): RemoteRequestContextDecision => ({
  allowed: false,
  code,
  stage: 'request-context',
})

const normalizeHost = (value: string | undefined): string | null => {
  const candidate = value?.trim().toLowerCase()
  if (!candidate || /[,/@?#\\\s]/.test(candidate)) return null
  try {
    return new URL(`http://${candidate}`).host.toLowerCase()
  } catch {
    return null
  }
}

const normalizeOrigin = (value: string | undefined): string | null => {
  if (!value || value === 'null') return null
  try {
    const parsed = new URL(value)
    if (parsed.username || parsed.password || parsed.pathname !== '/'
      || parsed.search || parsed.hash || !['http:', 'https:'].includes(parsed.protocol)) return null
    return parsed.origin.toLowerCase()
  } catch {
    return null
  }
}

const secureExpectedOrigin = (value: string): boolean => {
  try {
    const parsed = new URL(value)
    const loopback = ['127.0.0.1', '::1', '[::1]', 'localhost'].includes(parsed.hostname)
    return parsed.protocol === 'https:' || (parsed.protocol === 'http:' && loopback)
  } catch {
    return false
  }
}

const equalSecret = (left: string, right: string): boolean => {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer)
}

export function evaluateRemoteRequestContext(
  policy: RemoteRequestContextPolicy,
  input: RemoteRequestContextInput,
): RemoteRequestContextDecision {
  if (!policy.expectedHosts.length || !policy.expectedOrigins.length
    || policy.expectedHosts.some((host) => normalizeHost(host) === null)
    || policy.expectedOrigins.some((origin) => (
      normalizeOrigin(origin) === null || !secureExpectedOrigin(origin)
    ))) {
    throw new Error('remote request context policy requires valid expected hosts and origins')
  }
  const directHost = normalizeHost(input.host)
  if (!input.host) return deny('host_missing')
  if (!directHost) return deny('host_invalid')

  const hasForwardedHost = input.forwardedHost !== undefined
  const proxyTrusted = policy.trustedProxyAddresses.includes(input.remoteAddress)
  if (hasForwardedHost && (!policy.trustForwardedHost || !proxyTrusted)) {
    return deny('forwarded_host_untrusted')
  }
  const forwardedHost = hasForwardedHost ? normalizeHost(input.forwardedHost) : null
  if (hasForwardedHost && !forwardedHost) return deny('host_invalid')
  const effectiveHost = forwardedHost ?? directHost
  const expectedHosts = policy.expectedHosts.map(normalizeHost).filter((host): host is string => host !== null)
  if (!expectedHosts.includes(effectiveHost)) return deny('host_untrusted')

  const method = input.method.trim().toUpperCase()
  const stateChanging = !['GET', 'HEAD', 'OPTIONS'].includes(method)
  if (input.credentialTransport === 'stream-ticket-query'
    && (input.requestPurpose !== 'stream' || method !== 'GET')) {
    return deny('query_credential_forbidden')
  }

  const normalizedOrigin = normalizeOrigin(input.origin)
  const expectedOrigins = policy.expectedOrigins
    .map(normalizeOrigin)
    .filter((origin): origin is string => origin !== null)
  if (input.origin !== undefined && !normalizedOrigin) return deny('origin_invalid')
  if (normalizedOrigin && !expectedOrigins.includes(normalizedOrigin)) return deny('origin_untrusted')

  if (stateChanging && input.clientKind === 'browser') {
    if (!normalizedOrigin) return deny('origin_missing')
    const fetchSite = input.secFetchSite?.trim().toLowerCase()
    if (!fetchSite) return deny('fetch_metadata_missing')
    if (fetchSite !== 'same-origin') return deny('cross_site_request')
    if (input.credentialTransport === 'cookie') {
      if (!input.csrfCookie || !input.csrfHeader) return deny('csrf_token_missing')
      if (!equalSecret(input.csrfCookie, input.csrfHeader)) return deny('csrf_token_mismatch')
    }
  }

  if (stateChanging && input.clientKind === 'non-browser'
    && input.credentialTransport !== 'proof-bound-header') {
    return deny('origin_missing')
  }

  return {
    allowed: true,
    effectiveHost,
    normalizedOrigin,
    stateChanging,
    credentialTransport: input.credentialTransport,
  }
}

/** Apply to authenticated and bootstrap responses; step-up remains the primary privileged defense. */
export const REMOTE_BROWSER_SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  // img-src additionally allows blob: (image attachments are fetched with auth headers
  // and handed to <img> as object URLs) and data: (inline favicon). Scripts stay 'self'.
  'content-security-policy': "default-src 'self'; img-src 'self' blob: data:; style-src 'self'; script-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'",
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
})

export interface RemoteRateLimitPolicy {
  family: RemoteRateLimitFamily
  limit: number
  windowMs: number
  requiredDimensions: readonly ('origin' | 'device' | 'account')[]
}

export const DEFAULT_REMOTE_RATE_LIMIT_POLICIES: readonly RemoteRateLimitPolicy[] = Object.freeze([
  { family: 'request', limit: 120, windowMs: 60_000, requiredDimensions: ['origin'] },
  { family: 'command', limit: 30, windowMs: 60_000, requiredDimensions: ['origin', 'device', 'account'] },
  { family: 'provider', limit: 20, windowMs: 60_000, requiredDimensions: ['origin', 'device', 'account'] },
  { family: 'pairing', limit: 5, windowMs: 5 * 60_000, requiredDimensions: ['origin', 'account'] },
  { family: 'auth-failure', limit: 10, windowMs: 5 * 60_000, requiredDimensions: ['origin', 'device', 'account'] },
  { family: 'stream', limit: 6, windowMs: 60_000, requiredDimensions: ['origin', 'device', 'account'] },
  { family: 'approval', limit: 20, windowMs: 60_000, requiredDimensions: ['origin', 'device', 'account'] },
  { family: 'pty-write', limit: 60, windowMs: 10_000, requiredDimensions: ['origin', 'device', 'account'] },
  { family: 'admin', limit: 10, windowMs: 60_000, requiredDimensions: ['origin', 'device', 'account'] },
])

type PrivacySafeDigest = `sha256:${string}`

export interface RemoteRateLimitSubject {
  originDigest: PrivacySafeDigest
  deviceDigest?: PrivacySafeDigest
  accountDigest?: PrivacySafeDigest
}

export interface RemoteRateLimitRequest {
  family: RemoteRateLimitFamily
  subject: RemoteRateLimitSubject
  cost?: number
}

export interface RemoteRateLimitDecision {
  allowed: boolean
  reason: 'allowed' | 'rate_limited' | 'capacity_exhausted' | 'store_invalid'
  family: RemoteRateLimitFamily
  limit: number
  remaining: number
  retryAfterMs: number
  privacySafeDimensions: readonly ('origin' | 'device' | 'account')[]
}

export interface RemoteRateLimitWindow {
  count: number
  resetAt: number
}

export interface RemoteRateLimitStoreConsumeRequest {
  keys: readonly string[]
  cost: number
  limit: number
  windowMs: number
  nowMs: number
  maxEntries: number
}

export interface RemoteRateLimitStoreConsumeResult {
  capacityExhausted: boolean
  windows: readonly RemoteRateLimitWindow[]
}

/** Durable implementations must atomically update every key in one transaction. */
export interface RemoteRateLimitStateStore {
  readonly persistence: 'durable' | 'ephemeral'
  consume(request: RemoteRateLimitStoreConsumeRequest): RemoteRateLimitStoreConsumeResult
  prune(nowMs: number): number
}

/** Explicitly test-only unless the caller opts into restart-evasive security behavior. */
export class InMemoryRemoteRateLimitStateStore implements RemoteRateLimitStateStore {
  readonly persistence = 'ephemeral' as const
  readonly #windows = new Map<string, RemoteRateLimitWindow>()

  consume(request: RemoteRateLimitStoreConsumeRequest): RemoteRateLimitStoreConsumeResult {
    const newKeys = request.keys.filter((key) => !this.#windows.has(key)).length
    if (this.#windows.size + newKeys > request.maxEntries) this.prune(request.nowMs)
    if (this.#windows.size + newKeys > request.maxEntries) {
      return { capacityExhausted: true, windows: [] }
    }
    const windows = request.keys.map((key) => {
      const previous = this.#windows.get(key)
      const window = !previous || previous.resetAt <= request.nowMs
        ? { count: request.cost, resetAt: request.nowMs + request.windowMs }
        : { count: previous.count + request.cost, resetAt: previous.resetAt }
      this.#windows.set(key, window)
      return window
    })
    return { capacityExhausted: false, windows }
  }

  prune(nowMs: number): number {
    let removed = 0
    for (const [key, window] of this.#windows) {
      if (window.resetAt <= nowMs) {
        this.#windows.delete(key)
        removed += 1
      }
    }
    return removed
  }
}

export interface RemoteRateLimiterOptions {
  maxEntries?: number
  allowEphemeralForTests?: boolean
  clock?: () => number
}

const DIGEST = /^sha256:[0-9a-f]{64}$/

const assertDigest = (label: string, value: string | undefined, required: boolean): void => {
  if (required && !value) throw new Error(`${label} digest is required`)
  if (value && !DIGEST.test(value)) throw new Error(`${label} must be a privacy-safe sha256 digest`)
}

/** Use a process-local pepper; only the digest is retained in limiter keys and alert dimensions. */
export function privacySafeRateLimitDigest(
  dimension: 'origin' | 'device' | 'account',
  value: string,
  pepper: string,
): PrivacySafeDigest {
  if (!value.trim() || !pepper) throw new Error('rate-limit identity and pepper are required')
  return `sha256:${createHash('sha256').update(`${dimension}\0${pepper}\0${value}`).digest('hex')}`
}

export class RemoteRateLimiter {
  readonly #policies: ReadonlyMap<RemoteRateLimitFamily, RemoteRateLimitPolicy>
  readonly #store: RemoteRateLimitStateStore
  readonly #maxEntries: number
  readonly #clock: () => number

  constructor(
    store: RemoteRateLimitStateStore,
    policies: readonly RemoteRateLimitPolicy[] = DEFAULT_REMOTE_RATE_LIMIT_POLICIES,
    options: RemoteRateLimiterOptions = {},
  ) {
    const indexed = new Map<RemoteRateLimitFamily, RemoteRateLimitPolicy>()
    for (const policy of policies) {
      if (!Number.isSafeInteger(policy.limit) || policy.limit <= 0
        || !Number.isSafeInteger(policy.windowMs) || policy.windowMs <= 0) {
        throw new Error(`invalid ${policy.family} rate-limit policy`)
      }
      if (indexed.has(policy.family)) throw new Error(`duplicate ${policy.family} rate-limit policy`)
      if (!policy.requiredDimensions.includes('origin')
        || new Set(policy.requiredDimensions).size !== policy.requiredDimensions.length) {
        throw new Error(`${policy.family} rate-limit dimensions must be unique and include origin`)
      }
      indexed.set(policy.family, Object.freeze({
        ...policy,
        requiredDimensions: Object.freeze([...policy.requiredDimensions]),
      }))
    }
    if (store.persistence !== 'durable'
      && policies.some(({ family }) => family !== 'request')
      && !options.allowEphemeralForTests) {
      throw new Error('security-critical rate limits require a durable state store')
    }
    const maxEntries = options.maxEntries ?? 50_000
    if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
      throw new Error('rate-limit maxEntries must be a positive safe integer')
    }
    this.#policies = indexed
    this.#store = store
    this.#maxEntries = maxEntries
    this.#clock = options.clock ?? Date.now
  }

  consume(request: RemoteRateLimitRequest): RemoteRateLimitDecision {
    const policy = this.#policies.get(request.family)
    if (!policy) throw new Error(`unclassified rate-limit family ${request.family}`)
    const cost = request.cost ?? 1
    if (!Number.isSafeInteger(cost) || cost <= 0 || cost > policy.limit) {
      throw new Error('rate-limit cost must be a positive integer within the policy limit')
    }
    assertDigest('origin', request.subject.originDigest, true)
    assertDigest('device', request.subject.deviceDigest, policy.requiredDimensions.includes('device'))
    assertDigest('account', request.subject.accountDigest, policy.requiredDimensions.includes('account'))

    const nowMs = this.#clock()
    if (!Number.isFinite(nowMs) || nowMs < 0) throw new Error('rate-limit clock must be finite')
    const dimensions: Array<['origin' | 'device' | 'account', PrivacySafeDigest]> = [
      ['origin', request.subject.originDigest],
    ]
    if (request.subject.deviceDigest) dimensions.push(['device', request.subject.deviceDigest])
    if (request.subject.accountDigest) dimensions.push(['account', request.subject.accountDigest])

    const consumed = this.#store.consume({
      keys: dimensions.map(([dimension, digest]) => `${request.family}:${dimension}:${digest}`),
      cost,
      limit: policy.limit,
      windowMs: policy.windowMs,
      nowMs,
      maxEntries: this.#maxEntries,
    })
    if (consumed.capacityExhausted) {
      return {
        allowed: false,
        reason: 'capacity_exhausted',
        family: request.family,
        limit: policy.limit,
        remaining: 0,
        retryAfterMs: policy.windowMs,
        privacySafeDimensions: dimensions.map(([dimension]) => dimension),
      }
    }
    const windows = consumed.windows
    const storeValid = consumed.capacityExhausted === false
      && Array.isArray(windows)
      && windows.length === dimensions.length
      && windows.every(({ count, resetAt }) => (
        Number.isSafeInteger(count) && count >= cost
        && Number.isFinite(resetAt) && resetAt > nowMs && resetAt <= nowMs + policy.windowMs
      ))
    if (!storeValid) {
      return {
        allowed: false,
        reason: 'store_invalid',
        family: request.family,
        limit: policy.limit,
        remaining: 0,
        retryAfterMs: policy.windowMs,
        privacySafeDimensions: dimensions.map(([dimension]) => dimension),
      }
    }
    const highestCount = Math.max(...windows.map(({ count }) => count))
    const deniedWindows = windows.filter(({ count }) => count > policy.limit)
    const allowed = deniedWindows.length === 0
    const retryAfterMs = deniedWindows.reduce(
      (highest, { resetAt }) => Math.max(highest, Math.max(0, resetAt - nowMs)), 0,
    )

    return {
      allowed,
      reason: allowed ? 'allowed' : 'rate_limited',
      family: request.family,
      limit: policy.limit,
      remaining: Math.max(0, policy.limit - highestCount),
      retryAfterMs,
      privacySafeDimensions: dimensions.map(([dimension]) => dimension),
    }
  }

  prune(): number {
    const nowMs = this.#clock()
    if (!Number.isFinite(nowMs) || nowMs < 0) throw new Error('rate-limit clock must be finite')
    return this.#store.prune(nowMs)
  }
}
