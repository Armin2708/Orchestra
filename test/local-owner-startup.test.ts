import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  LocalOwnerConnecting,
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
    })).toBe('connecting')

    const markup = renderToStaticMarkup(createElement(LocalOwnerConnecting))
    expect(markup).toContain('aria-busy="true"')
    expect(markup).toContain('role="status"')
    expect(markup).toContain('aria-live="polite"')
    expect(markup).toContain('Connecting to Orchestra')
    expect(markup).toContain('Loading authenticated project data')
    for (const heavySurface of [
      'cc-shell', 'SystemMeter', 'OpenWorkView', 'RemoteAccessProvider', 'PhoneRemoteDock',
    ]) expect(markup).not.toContain(heavySurface)
  })

  it('keeps heavy endpoint-owning components behind the first-connection return', () => {
    const connectingReturn = appSource.indexOf("if (localOwnerSurface === 'connecting')")
    expect(connectingReturn).toBeGreaterThan(-1)
    for (const heavyMount of [
      '<RemoteAccessProvider>', '<SystemMeter', '<CommandCenter key=', '<OpenWorkView', '<PhoneRemoteDock',
    ]) {
      expect(connectingReturn).toBeLessThan(appSource.indexOf(heavyMount))
    }
  })

  it('shows Login when the initial request receives a 401 challenge', () => {
    expect(resolveLocalOwnerSurface({
      needsAuth: true,
      hasConnected: false,
      connectionState: 'offline',
    })).toBe('login')
    expect(appSource).toContain("if (reason instanceof ApiError && reason.status === 401) setNeedsAuth(true)")
    expect(appSource).toContain("if (localOwnerSurface === 'login')")
    expect(appSource).toContain('return <Login onSubmit=')
  })

  it('mounts the full application at live readiness and preserves it after a later disconnect', () => {
    expect(resolveLocalOwnerSurface({
      needsAuth: false,
      hasConnected: false,
      connectionState: 'live',
    })).toBe('application')
    expect(resolveLocalOwnerSurface({
      needsAuth: false,
      hasConnected: true,
      connectionState: 'stale',
    })).toBe('application')
    expect(resolveLocalOwnerSurface({
      needsAuth: false,
      hasConnected: true,
      connectionState: 'offline',
    })).toBe('application')
    expect(appSource).toContain('hasConnectedRef.current = true')
    expect(appSource).toContain("setConnectionState(hasConnectedRef.current ? 'stale' : 'offline')")
  })
})
