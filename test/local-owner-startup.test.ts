import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  beginLocalOwnerAuthentication,
  beginLocalOwnerRetry,
  LocalOwnerConnecting,
  LocalOwnerInitialOffline,
  resolveLocalOwnerSurface,
} from '../web/src/LocalOwnerStartup.js'

const requireFromWeb = createRequire(new URL('../web/package.json', import.meta.url))
const { createElement } = requireFromWeb('react') as {
  createElement: (component: unknown, props?: Record<string, unknown>) => unknown
}
const { renderToStaticMarkup } = requireFromWeb('react-dom/server') as {
  renderToStaticMarkup: (node: unknown) => string
}
const appSource = readFileSync(new URL('../web/src/App.tsx', import.meta.url), 'utf8')

describe('local-owner first connection', () => {
  it('renders an accessible lightweight shell before the first successful connection', () => {
    expect(resolveLocalOwnerSurface({
      needsAuth: false,
      hasConnected: false,
      connectionState: 'offline',
      loaded: false,
    })).toBe('connecting')

    const markup = renderToStaticMarkup(createElement(LocalOwnerConnecting))
    expect(markup).toContain('aria-busy="true"')
    expect(markup).toContain('role="status"')
    expect(markup).toContain('aria-live="polite"')
    expect(markup).toContain('/icons/orchestra-mark.svg')
    expect(markup).toContain('Connecting to Orchestra')
    expect(markup).toContain('Loading authenticated project data')
    for (const heavySurface of [
      'cc-shell', 'SystemMeter', 'OpenWorkView', 'RemoteAccessProvider', 'PhoneRemoteDock',
    ]) expect(markup).not.toContain(heavySurface)
  })

  it('turns a settled first failure into an actionable non-busy offline state', () => {
    expect(resolveLocalOwnerSurface({
      needsAuth: false,
      hasConnected: false,
      connectionState: 'offline',
      loaded: true,
    })).toBe('initial-offline')

    const markup = renderToStaticMarkup(createElement(LocalOwnerInitialOffline, { onRetry: () => undefined }))
    expect(markup).toContain('role="alert"')
    expect(markup).not.toContain('aria-busy="true"')
    expect(markup).toContain('/icons/orchestra-mark.svg')
    expect(markup).toContain('Orchestra is unavailable')
    expect(markup).toContain('keep retrying automatically')
    expect(markup).toContain('Retry now')
    for (const heavySurface of [
      'cc-shell', 'SystemMeter', 'OpenWorkView', 'RemoteAccessProvider', 'PhoneRemoteDock',
    ]) expect(markup).not.toContain(heavySurface)
  })

  it('returns to the connecting state before issuing an explicit retry', () => {
    const order: string[] = []
    beginLocalOwnerRetry(
      () => order.push('loading'),
      () => order.push('refresh'),
    )
    expect(order).toEqual(['loading', 'refresh'])
    expect(appSource).toContain('beginLocalOwnerRetry(() => setLoaded(false), refresh)')
  })

  it('keeps heavy endpoint-owning components behind the first-connection return', () => {
    const connectingReturn = appSource.indexOf("if (localOwnerSurface === 'connecting')")
    const offlineReturn = appSource.indexOf("if (localOwnerSurface === 'initial-offline')")
    expect(connectingReturn).toBeGreaterThan(-1)
    expect(offlineReturn).toBeGreaterThan(connectingReturn)
    for (const heavyMount of [
      '<RemoteAccessProvider>', '<SystemMeter', '<BoardSection', '<PhoneRemoteDock',
    ]) {
      expect(connectingReturn).toBeLessThan(appSource.indexOf(heavyMount))
      expect(offlineReturn).toBeLessThan(appSource.indexOf(heavyMount))
    }
  })

  it('shows Login when the initial request receives a 401 challenge', () => {
    expect(resolveLocalOwnerSurface({
      needsAuth: true,
      hasConnected: false,
      connectionState: 'offline',
      loaded: true,
    })).toBe('login')
    expect(appSource).toContain("if (reason instanceof ApiError && reason.status === 401) setNeedsAuth(true)")
    expect(appSource).toContain("if (localOwnerSurface === 'login')")
    expect(appSource).toContain('return <Login onSubmit=')
  })

  it('transitions a successful Login submission through auth-pending before the application', () => {
    const state = {
      token: '',
      needsAuth: true,
      loaded: true,
      hasConnected: false,
      connectionState: 'offline' as const,
    }
    const order: string[] = []
    beginLocalOwnerAuthentication({
      token: 'owner-token',
      acceptToken: (token) => { state.token = token; order.push('token') },
      markLoading: () => { state.loaded = false; order.push('loading') },
      clearAuthenticationChallenge: () => { state.needsAuth = false; order.push('clear-auth') },
    })
    expect(order).toEqual(['token', 'loading', 'clear-auth'])
    expect(state.token).toBe('owner-token')
    expect(resolveLocalOwnerSurface(state)).toBe('connecting')

    expect(resolveLocalOwnerSurface({
      ...state,
      loaded: true,
      hasConnected: true,
      connectionState: 'live',
    })).toBe('application')
    expect(appSource.indexOf('markLoading: () => setLoaded(false)'))
      .toBeLessThan(appSource.indexOf('clearAuthenticationChallenge: () => setNeedsAuth(false)'))
  })

  it('returns a rejected token attempt to Login instead of initial-offline', () => {
    const state = {
      token: '',
      needsAuth: true,
      loaded: true,
      hasConnected: false,
      connectionState: 'offline' as const,
    }
    beginLocalOwnerAuthentication({
      token: 'bad-token',
      acceptToken: (token) => { state.token = token },
      markLoading: () => { state.loaded = false },
      clearAuthenticationChallenge: () => { state.needsAuth = false },
    })
    expect(resolveLocalOwnerSurface(state)).toBe('connecting')

    state.needsAuth = true
    state.loaded = true
    expect(resolveLocalOwnerSurface(state)).toBe('login')
  })

  it('mounts the full application at live readiness and preserves it after a later disconnect', () => {
    expect(resolveLocalOwnerSurface({
      needsAuth: false,
      hasConnected: false,
      connectionState: 'live',
      loaded: false,
    })).toBe('application')
    expect(resolveLocalOwnerSurface({
      needsAuth: false,
      hasConnected: true,
      connectionState: 'stale',
      loaded: true,
    })).toBe('application')
    expect(resolveLocalOwnerSurface({
      needsAuth: false,
      hasConnected: true,
      connectionState: 'offline',
      loaded: true,
    })).toBe('application')
    expect(appSource).toContain('hasConnectedRef.current = true')
    expect(appSource).toContain("setConnectionState(hasConnectedRef.current ? 'stale' : 'offline')")
  })
})
