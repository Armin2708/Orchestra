import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@clerk/react', () => ({ getToken: vi.fn(async () => 'clerk_jwt_abc') }))

import { getToken } from '@clerk/react'
import { hubFetch, hubConfigured, __setHubEnvOverrideForTest, HubApiError } from '../src/hubApi.js'

const mockedGetToken = vi.mocked(getToken)

describe('web/src/hubApi', () => {
  afterEach(() => {
    __setHubEnvOverrideForTest(null)
    vi.unstubAllGlobals()
    mockedGetToken.mockReset()
    mockedGetToken.mockResolvedValue('clerk_jwt_abc' as any)
  })

  describe('hubConfigured', () => {
    it('is false when neither VITE_HUB_BASE_URL nor VITE_CLERK_PUBLISHABLE_KEY is set — real local single-machine mode', () => {
      __setHubEnvOverrideForTest({ VITE_HUB_BASE_URL: undefined, VITE_CLERK_PUBLISHABLE_KEY: undefined })
      expect(hubConfigured()).toBe(false)
    })

    it('is false when only VITE_HUB_BASE_URL is set', () => {
      __setHubEnvOverrideForTest({ VITE_HUB_BASE_URL: 'https://hub.example.com', VITE_CLERK_PUBLISHABLE_KEY: undefined })
      expect(hubConfigured()).toBe(false)
    })

    it('is false when only VITE_CLERK_PUBLISHABLE_KEY is set', () => {
      __setHubEnvOverrideForTest({ VITE_HUB_BASE_URL: undefined, VITE_CLERK_PUBLISHABLE_KEY: 'pk_test_x' })
      expect(hubConfigured()).toBe(false)
    })

    it('is true when both are set', () => {
      __setHubEnvOverrideForTest({ VITE_HUB_BASE_URL: 'https://hub.example.com', VITE_CLERK_PUBLISHABLE_KEY: 'pk_test_x' })
      expect(hubConfigured()).toBe(true)
    })
  })

  describe('hubFetch — local mode (unconfigured) must never blank the board', () => {
    it('throws without ever calling fetch or getToken when unconfigured', async () => {
      __setHubEnvOverrideForTest({ VITE_HUB_BASE_URL: undefined, VITE_CLERK_PUBLISHABLE_KEY: undefined })
      const fetchSpy = vi.fn()
      vi.stubGlobal('fetch', fetchSpy)

      await expect(hubFetch('GET', '/orgs/org_a/cards')).rejects.toThrow(HubApiError)

      expect(fetchSpy).not.toHaveBeenCalled()
      expect(mockedGetToken).not.toHaveBeenCalled()
    })
  })

  describe('hubFetch — configured', () => {
    beforeEach(() => {
      __setHubEnvOverrideForTest({ VITE_HUB_BASE_URL: 'https://hub.example.com', VITE_CLERK_PUBLISHABLE_KEY: 'pk_test_x' })
    })

    it('sends the Clerk token as a Bearer header to the hub origin, under /api/v1/hub', async () => {
      const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
      vi.stubGlobal('fetch', fetchSpy)

      const result = await hubFetch('GET', '/orgs/org_a/cards')

      expect(result).toEqual({ ok: true })
      expect(fetchSpy).toHaveBeenCalledTimes(1)
      const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
      expect(url).toBe('https://hub.example.com/api/v1/hub/orgs/org_a/cards')
      expect(init.method).toBe('GET')
      expect((init.headers as Record<string, string>).authorization).toBe('Bearer clerk_jwt_abc')
      expect(init.credentials).toBe('omit')
    })

    // Reported in real use: connecting an org gave "user is not a member of this org", and
    // a page refresh fixed it. Clerk serves a CACHED session token, and the hub reads the
    // active org from that token's org_id claim — so right after sign-in or an org switch
    // the cached claim is stale and the hub correctly refuses it.
    it('retries once with a fresh token when the hub answers 403', async () => {
      mockedGetToken.mockImplementation(async (options?: { skipCache?: boolean }) =>
        (options?.skipCache ? 'clerk_jwt_fresh' : 'clerk_jwt_stale') as any)
      const fetchSpy = vi.fn(async (_url: string, init: RequestInit) =>
        (init.headers as Record<string, string>).authorization === 'Bearer clerk_jwt_fresh'
          ? new Response(JSON.stringify({ ok: true }), { status: 200 })
          : new Response(JSON.stringify({ error: 'user is not a member of this org', code: 'forbidden' }), { status: 403 }))
      vi.stubGlobal('fetch', fetchSpy)

      const result = await hubFetch('GET', '/orgs/org_a/cards')

      expect(result).toEqual({ ok: true })
      expect(fetchSpy).toHaveBeenCalledTimes(2)
      expect(mockedGetToken).toHaveBeenCalledWith({ skipCache: true })
    })

    it('gives up after one retry so a genuine non-member still fails', async () => {
      mockedGetToken.mockImplementation(async (options?: { skipCache?: boolean }) =>
        (options?.skipCache ? 'clerk_jwt_fresh' : 'clerk_jwt_stale') as any)
      const fetchSpy = vi.fn(async () =>
        new Response(JSON.stringify({ error: 'user is not a member of this org', code: 'forbidden' }), { status: 403 }))
      vi.stubGlobal('fetch', fetchSpy)

      await expect(hubFetch('GET', '/orgs/org_a/cards')).rejects.toMatchObject({
        status: 403, message: 'user is not a member of this org',
      })
      expect(fetchSpy).toHaveBeenCalledTimes(2)
    })

    it('does not retry when the fresh token is the same one that just failed', async () => {
      const fetchSpy = vi.fn(async () =>
        new Response(JSON.stringify({ error: 'nope', code: 'forbidden' }), { status: 403 }))
      vi.stubGlobal('fetch', fetchSpy)

      await expect(hubFetch('GET', '/orgs/org_a/cards')).rejects.toMatchObject({ status: 403 })
      expect(fetchSpy).toHaveBeenCalledTimes(1)
    })

    it('does not retry a non-403 failure', async () => {
      const fetchSpy = vi.fn(async () =>
        new Response(JSON.stringify({ error: 'boom', code: 'internal' }), { status: 500 }))
      vi.stubGlobal('fetch', fetchSpy)

      await expect(hubFetch('GET', '/orgs/org_a/cards')).rejects.toMatchObject({ status: 500 })
      expect(fetchSpy).toHaveBeenCalledTimes(1)
    })

    it('serializes a body as JSON with a content-type header', async () => {
      const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ id: 1 }), { status: 200 }))
      vi.stubGlobal('fetch', fetchSpy)

      await hubFetch('POST', '/orgs/org_a/ops', { op: 'card.create', payload: { title: 'x' } })

      const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
      expect(init.body).toBe(JSON.stringify({ op: 'card.create', payload: { title: 'x' } }))
      expect((init.headers as Record<string, string>)['content-type']).toBe('application/json')
    })

    it('omits content-type when no body is given', async () => {
      const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }))
      vi.stubGlobal('fetch', fetchSpy)

      await hubFetch('GET', '/orgs/org_a/cards')

      const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
      expect((init.headers as Record<string, string>)['content-type']).toBeUndefined()
    })

    it('throws HubApiError with the response status on a non-ok response', async () => {
      const fetchSpy = vi.fn(async () => new Response('nope', { status: 403 }))
      vi.stubGlobal('fetch', fetchSpy)

      await expect(hubFetch('GET', '/orgs/org_a/cards')).rejects.toMatchObject({ status: 403 })
    })

    it('extracts the .error field from a hub error body, rather than surfacing raw JSON', async () => {
      const body = JSON.stringify({ error: 'seat cap reached: this org is entitled to 3 seat(s)', code: 'forbidden' })
      const fetchSpy = vi.fn(async () => new Response(body, { status: 403 }))
      vi.stubGlobal('fetch', fetchSpy)

      await expect(hubFetch('POST', '/orgs/org_a/devices')).rejects.toMatchObject({
        status: 403, message: 'seat cap reached: this org is entitled to 3 seat(s)',
      })
    })

    it('falls back to the raw response text when the error body is not the expected {error} shape', async () => {
      const fetchSpy = vi.fn(async () => new Response('<html>502 Bad Gateway</html>', { status: 502 }))
      vi.stubGlobal('fetch', fetchSpy)

      await expect(hubFetch('GET', '/orgs/org_a/cards')).rejects.toMatchObject({
        status: 502, message: '<html>502 Bad Gateway</html>',
      })
    })

    it('throws HubApiError without calling fetch when there is no Clerk session (getToken resolves null)', async () => {
      mockedGetToken.mockResolvedValue(null as any)
      const fetchSpy = vi.fn()
      vi.stubGlobal('fetch', fetchSpy)

      await expect(hubFetch('GET', '/orgs/org_a/cards')).rejects.toThrow(HubApiError)
      expect(fetchSpy).not.toHaveBeenCalled()
    })
  })
})
