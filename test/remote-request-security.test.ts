import { describe, expect, it } from 'vitest'
import {
  DEFAULT_REMOTE_RATE_LIMIT_POLICIES,
  InMemoryRemoteRateLimitStateStore,
  REMOTE_BROWSER_SECURITY_HEADERS,
  RemoteRateLimiter,
  evaluateRemoteRequestContext,
  privacySafeRateLimitDigest,
  type RemoteRequestContextPolicy,
  type RemoteRateLimitStateStore,
} from '../src/remote-request-security.js'

const policy: RemoteRequestContextPolicy = {
  expectedHosts: ['device.example.test', '127.0.0.1:4750'],
  expectedOrigins: ['https://device.example.test', 'http://127.0.0.1:4750'],
  trustedProxyAddresses: ['127.0.0.1'],
  trustForwardedHost: true,
}

const mutation = {
  method: 'POST',
  host: 'device.example.test',
  origin: 'https://device.example.test',
  secFetchSite: 'same-origin',
  remoteAddress: '203.0.113.10',
  clientKind: 'browser' as const,
  credentialTransport: 'authorization-header' as const,
  requestPurpose: 'api' as const,
}

const durableStore = (): RemoteRateLimitStateStore => {
  const memory = new InMemoryRemoteRateLimitStateStore()
  return {
    persistence: 'durable',
    consume: (request) => memory.consume(request),
    prune: (nowMs) => memory.prune(nowMs),
  }
}

describe('remote request context policy', () => {
  it('accepts an expected same-origin browser mutation before credential authorization', () => {
    expect(evaluateRemoteRequestContext(policy, mutation)).toEqual({
      allowed: true,
      effectiveHost: 'device.example.test',
      normalizedOrigin: 'https://device.example.test',
      stateChanging: true,
      credentialTransport: 'authorization-header',
    })
  })

  it.each([
    [{ ...mutation, host: 'attacker.example' }, 'host_untrusted'],
    [{ ...mutation, host: 'attacker@device.example.test' }, 'host_invalid'],
    [{ ...mutation, origin: 'https://attacker.example' }, 'origin_untrusted'],
    [{ ...mutation, origin: undefined }, 'origin_missing'],
    [{ ...mutation, secFetchSite: undefined }, 'fetch_metadata_missing'],
    [{ ...mutation, secFetchSite: 'cross-site' }, 'cross_site_request'],
  ])('rejects hostile context %# before authentication', (input, code) => {
    expect(evaluateRemoteRequestContext(policy, input)).toEqual({
      allowed: false,
      code,
      stage: 'request-context',
    })
  })

  it('trusts forwarded host only from an explicitly trusted proxy', () => {
    expect(evaluateRemoteRequestContext(policy, {
      ...mutation,
      host: '127.0.0.1:4750',
      forwardedHost: 'device.example.test',
      remoteAddress: '127.0.0.1',
    })).toMatchObject({ allowed: true, effectiveHost: 'device.example.test' })
    expect(evaluateRemoteRequestContext(policy, {
      ...mutation,
      forwardedHost: 'device.example.test',
      remoteAddress: '203.0.113.10',
    })).toMatchObject({ allowed: false, code: 'forwarded_host_untrusted' })
  })

  it('requires double-submit CSRF for cookie auth and proof binding for non-browser mutations', () => {
    expect(evaluateRemoteRequestContext(policy, {
      ...mutation, credentialTransport: 'cookie', csrfCookie: 'csrf-1', csrfHeader: 'csrf-1',
    })).toMatchObject({ allowed: true })
    expect(evaluateRemoteRequestContext(policy, {
      ...mutation, credentialTransport: 'cookie', csrfCookie: 'csrf-1', csrfHeader: 'csrf-2',
    })).toMatchObject({ allowed: false, code: 'csrf_token_mismatch' })
    expect(evaluateRemoteRequestContext(policy, {
      ...mutation,
      clientKind: 'non-browser', credentialTransport: 'authorization-header',
      origin: undefined, secFetchSite: undefined,
    })).toMatchObject({ allowed: false, code: 'origin_missing' })
    expect(evaluateRemoteRequestContext(policy, {
      ...mutation,
      clientKind: 'non-browser', credentialTransport: 'proof-bound-header',
      origin: undefined, secFetchSite: undefined,
    })).toMatchObject({ allowed: true })
  })

  it('permits query credentials only for one-purpose GET streams', () => {
    expect(evaluateRemoteRequestContext(policy, {
      ...mutation,
      method: 'GET', credentialTransport: 'stream-ticket-query', requestPurpose: 'stream',
    })).toMatchObject({ allowed: true })
    expect(evaluateRemoteRequestContext(policy, {
      ...mutation,
      method: 'POST', credentialTransport: 'stream-ticket-query', requestPurpose: 'api',
    })).toMatchObject({ allowed: false, code: 'query_credential_forbidden' })
  })

  it('publishes an anti-framing and no-referrer header baseline', () => {
    expect(REMOTE_BROWSER_SECURITY_HEADERS['content-security-policy']).toContain("frame-ancestors 'none'")
    expect(REMOTE_BROWSER_SECURITY_HEADERS['content-security-policy']).toContain("style-src 'self'")
    expect(REMOTE_BROWSER_SECURITY_HEADERS['content-security-policy']).not.toContain("'unsafe-inline'")
    expect(REMOTE_BROWSER_SECURITY_HEADERS['content-security-policy']).toContain("script-src 'self'")
    expect(REMOTE_BROWSER_SECURITY_HEADERS['x-frame-options']).toBe('DENY')
    expect(REMOTE_BROWSER_SECURITY_HEADERS['referrer-policy']).toBe('no-referrer')
  })

  it('rejects plaintext HTTP for every non-loopback configured origin', () => {
    expect(() => evaluateRemoteRequestContext({
      ...policy,
      expectedHosts: ['public.example'],
      expectedOrigins: ['http://public.example'],
    }, {
      ...mutation,
      host: 'public.example',
      origin: 'http://public.example',
    })).toThrow(/valid expected hosts and origins/)
    expect(evaluateRemoteRequestContext(policy, {
      ...mutation,
      host: '127.0.0.1:4750',
      origin: 'http://127.0.0.1:4750',
    })).toMatchObject({ allowed: true })
  })
})

describe('privacy-safe multi-dimensional rate limiting', () => {
  const digest = (dimension: 'origin' | 'device' | 'account', value: string) =>
    privacySafeRateLimitDigest(dimension, value, 'test-pepper')

  it('defines request, command, provider, and every remote high-risk family', () => {
    expect(DEFAULT_REMOTE_RATE_LIMIT_POLICIES.map(({ family }) => family).sort()).toEqual([
      'admin', 'approval', 'auth-failure', 'command', 'pairing', 'provider', 'pty-write', 'request', 'stream',
    ])
  })

  it('limits origin, device, and account dimensions without retaining raw identities', () => {
    let nowMs = 100
    const limiter = new RemoteRateLimiter(durableStore(), [{
      family: 'admin', limit: 2, windowMs: 1_000,
      requiredDimensions: ['origin', 'device', 'account'],
    }], { clock: () => nowMs })
    const subject = {
      originDigest: digest('origin', 'https://device.example.test'),
      deviceDigest: digest('device', 'device-session-1'),
      accountDigest: digest('account', 'user-1'),
    }
    expect(limiter.consume({ family: 'admin', subject })).toMatchObject({
      allowed: true, remaining: 1, privacySafeDimensions: ['origin', 'device', 'account'],
    })
    nowMs = 200
    expect(limiter.consume({ family: 'admin', subject })).toMatchObject({
      allowed: true, remaining: 0,
    })
    nowMs = 300
    expect(limiter.consume({ family: 'admin', subject })).toMatchObject({
      allowed: false, retryAfterMs: 800,
    })
    expect(JSON.stringify(subject)).not.toContain('device-session-1')
    expect(JSON.stringify(subject)).not.toContain('device.example.test')
  })

  it('isolates unrelated devices while still enforcing a shared account dimension', () => {
    const store = durableStore()
    let nowMs = 0
    const limiter = new RemoteRateLimiter(store, [{
      family: 'command', limit: 2, windowMs: 1_000,
      requiredDimensions: ['origin', 'device', 'account'],
    }], { clock: () => nowMs })
    const originDigest = digest('origin', 'origin-a')
    const accountDigest = digest('account', 'account-a')
    expect(limiter.consume({
      family: 'command',
      subject: { originDigest, accountDigest, deviceDigest: digest('device', 'device-a') },
    }).allowed).toBe(true)
    nowMs = 10
    expect(limiter.consume({
      family: 'command',
      subject: { originDigest: digest('origin', 'origin-b'), accountDigest, deviceDigest: digest('device', 'device-b') },
    }).allowed).toBe(true)
    nowMs = 20
    expect(limiter.consume({
      family: 'command',
      subject: { originDigest: digest('origin', 'origin-c'), accountDigest, deviceDigest: digest('device', 'device-c') },
    })).toMatchObject({ allowed: false })
    const replacement = new RemoteRateLimiter(store, [{
      family: 'command', limit: 2, windowMs: 1_000,
      requiredDimensions: ['origin', 'device', 'account'],
    }], { clock: () => nowMs })
    nowMs = 30
    expect(replacement.consume({
      family: 'command',
      subject: { originDigest: digest('origin', 'origin-d'), accountDigest, deviceDigest: digest('device', 'device-d') },
    })).toMatchObject({ allowed: false, reason: 'rate_limited' })
  })

  it('fails closed for malformed dimensions or an unclassified family', () => {
    const limiter = new RemoteRateLimiter(durableStore(), [{
      family: 'request', limit: 1, windowMs: 1_000, requiredDimensions: ['origin'],
    }], { clock: () => 100 })
    expect(() => limiter.consume({
      family: 'request', subject: { originDigest: 'sha256:raw-origin' },
    })).toThrow(/privacy-safe/)
    expect(() => limiter.consume({
      family: 'provider', subject: { originDigest: digest('origin', 'origin') },
    })).toThrow(/unclassified/)
    const privileged = new RemoteRateLimiter(durableStore(), [{
      family: 'admin', limit: 1, windowMs: 1_000,
      requiredDimensions: ['origin', 'device', 'account'],
    }], { clock: () => 100 })
    expect(() => privileged.consume({
      family: 'admin', subject: { originDigest: digest('origin', 'origin') },
    })).toThrow(/device digest is required/)
    const invalidClock = new RemoteRateLimiter(durableStore(), [{
      family: 'admin', limit: 1, windowMs: 1_000,
      requiredDimensions: ['origin', 'device', 'account'],
    }], { clock: () => Number.POSITIVE_INFINITY })
    expect(() => invalidClock.consume({
      family: 'admin',
      subject: {
        originDigest: digest('origin', 'origin'),
        deviceDigest: digest('device', 'device'),
        accountDigest: digest('account', 'account'),
      },
    })).toThrow(/clock must be finite/)
    expect(() => new RemoteRateLimiter(new InMemoryRemoteRateLimitStateStore(), [{
      family: 'admin', limit: 1, windowMs: 1_000,
      requiredDimensions: ['origin', 'device', 'account'],
    }])).toThrow(/durable state store/)
  })

  it('caps limiter state and makes auth failures aggregate by origin, attempted device, and account', () => {
    expect(DEFAULT_REMOTE_RATE_LIMIT_POLICIES.find(({ family }) => family === 'auth-failure')
      ?.requiredDimensions).toEqual(['origin', 'device', 'account'])
    const limiter = new RemoteRateLimiter(durableStore(), [{
      family: 'auth-failure', limit: 2, windowMs: 1_000,
      requiredDimensions: ['origin', 'device', 'account'],
    }], { maxEntries: 2, clock: () => 1 })
    expect(limiter.consume({
      family: 'auth-failure',
      subject: {
        originDigest: digest('origin', 'origin'),
        deviceDigest: digest('device', 'attempted-device'),
        accountDigest: digest('account', 'attempted-account'),
      },
    })).toMatchObject({ allowed: false, reason: 'capacity_exhausted' })
  })

  it('denies malformed durable-store results instead of calculating Infinity remaining', () => {
    const malformedStore: RemoteRateLimitStateStore = {
      persistence: 'durable',
      consume: () => ({ capacityExhausted: false, windows: [] }),
      prune: () => 0,
    }
    const limiter = new RemoteRateLimiter(malformedStore, [{
      family: 'admin', limit: 1, windowMs: 1_000,
      requiredDimensions: ['origin', 'device', 'account'],
    }], { clock: () => 100 })
    expect(limiter.consume({
      family: 'admin',
      subject: {
        originDigest: digest('origin', 'origin'),
        deviceDigest: digest('device', 'device'),
        accountDigest: digest('account', 'account'),
      },
    })).toMatchObject({ allowed: false, reason: 'store_invalid', remaining: 0 })
  })
})
