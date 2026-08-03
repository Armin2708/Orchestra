import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createSingleFlightRefresh } from '../web/src/singleFlightRefresh'

const component = readFileSync(new URL('../web/src/OutcomeDashboard.tsx', import.meta.url), 'utf8')
const app = readFileSync(new URL('../web/src/App.tsx', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../web/src/outcome-dashboard.css', import.meta.url), 'utf8')

const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept
    reject = decline
  })
  return { promise, reject, resolve }
}

const flushPromises = async () => {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('outcome dashboard UI contract', () => {
  it('presents usage beside verified quality and accepted-delivery attribution', () => {
    for (const label of [
      'Tokens / accepted delivery', 'Cached-input ratio', 'First useful result',
      'Verified delivery', 'Evidence-gap rate', 'Rejection rate', 'Human-override rate',
      'Context and coordination', 'Repeated Claude Read inputs', 'Job attribution',
    ]) expect(component).toContain(label)
    expect(component).toContain('Token reduction counts only when accepted-delivery quality holds.')
    expect(component).toContain('immutable knowledge-context')
    expect(component).toContain('Accepted-delivery receipt from job start')
    expect(component).toContain('<Data label="Model acknowledgements" value="Not available" />')
    expect(component).toContain('dashboard.exploration.likely_duplicates')
  })

  it('uses memory-authenticated polling and retains streaming for tokenless loopback daemons', () => {
    expect(component).toContain('authenticatedPolling ? null : new EventSource(streamUrl())')
    expect(component).toContain('if (authenticatedPolling) requestRefresh()')
    expect(component).not.toContain('setInterval')
    expect(component).toContain('stream?.close()')
    expect(component).toContain("payload.board_id !== boardId || payload.type !== 'outcome_analytics'")
    expect(component).toContain('setDashboard(null)')
    expect(component).toContain('dashboard.board_id !== boardId')
    const dashboardSetup = component.slice(
      component.indexOf('useEffect(() => {'),
      component.indexOf('const qualityTone'),
    )
    expect(dashboardSetup.indexOf('new EventSource(streamUrl())'))
      .toBeLessThan(dashboardSetup.indexOf('requestRefresh()'))
    expect(dashboardSetup).toContain('stream.onopen = () =>')
    expect(dashboardSetup).toContain('createSingleFlightRefresh({')
    expect(dashboardSetup).toContain('if (!queued && retry === undefined && (authenticatedPolling || !succeeded))')
    expect(dashboardSetup).toContain('let disposed = false')
    expect(dashboardSetup).toContain('disposed = true')
    expect(dashboardSetup).toContain('controller.dispose()')
    expect(dashboardSetup).toContain('refreshRequest.current = (visible = true) => controller.request(visible)')
    expect(dashboardSetup).toContain('window.clearTimeout(initialFallback)')
    expect(dashboardSetup).toContain('if (retry !== undefined) window.clearTimeout(retry)')
    expect(component).toContain('onClick={() => refreshRequest.current(true)}')
    expect(component).not.toContain('onClick={() => void load()}')
    expect(app).toContain('authenticatedPolling ? null : new EventSource(streamUrl())')
    expect(app).toContain('if (authenticatedPolling) requestRefresh()')
    expect(app).not.toContain('setInterval(refresh, 30_000)')
    const setup = app.slice(app.indexOf('// EventSource cannot carry'), app.indexOf('if (needsAuth) return <Login'))
    expect(setup.indexOf('new EventSource(streamUrl())'))
      .toBeLessThan(setup.indexOf('requestRefresh()'))
    expect(setup).toContain('es.onopen = () =>')
    expect(setup).toContain('requestRefresh()')
    expect(setup).toContain('if (!queued && retry === undefined && (authenticatedPolling || !succeeded))')
    expect(setup).toContain('retry = window.setTimeout(() =>')
    expect(setup).toContain('createSingleFlightRefresh({')
    expect(setup).toContain('let disposed = false')
    expect(setup).toContain('disposed = true')
    expect(setup).toContain('controller.dispose()')
    expect(setup).toContain('if (initialFallback !== undefined) clearTimeout(initialFallback)')
    expect(setup).toContain('if (retry !== undefined) clearTimeout(retry)')
  })

  it('serializes deferred refreshes and applies responses in request order', async () => {
    const requests = [deferred<number>(), deferred<number>()]
    const applied: number[] = []
    const loading: boolean[] = []
    let started = 0
    const controller = createSingleFlightRefresh({
      load: () => requests[started++].promise,
      onStart: (visible) => {
        if (visible) loading.push(true)
      },
      onSuccess: (value) => applied.push(value),
      onFailure: () => undefined,
      onSettled: (visible) => {
        if (visible) loading.push(false)
      },
    })

    controller.request(true)
    controller.request(true)
    expect(started).toBe(1)
    expect(loading).toEqual([true, true])
    requests[0].resolve(1)
    await flushPromises()
    expect(started).toBe(2)
    expect(applied).toEqual([1])
    expect(loading).toEqual([true, true])
    requests[1].resolve(2)
    await flushPromises()
    expect(applied).toEqual([1, 2])
    expect(loading).toEqual([true, true, false])
  })

  it('suppresses every callback after disposal during a deferred refresh', async () => {
    const request = deferred<number>()
    const callbacks: string[] = []
    const controller = createSingleFlightRefresh({
      load: () => request.promise,
      onSuccess: () => callbacks.push('success'),
      onFailure: () => callbacks.push('failure'),
      onSettled: () => callbacks.push('settled'),
      onCycle: () => callbacks.push('cycle'),
    })

    controller.request()
    controller.request()
    controller.dispose()
    request.resolve(1)
    await flushPromises()
    expect(callbacks).toEqual([])
  })

  it('has responsive, focus-visible and reduced-motion behavior', () => {
    expect(styles).toContain(':focus-visible')
    expect(styles).toContain('@media (max-width: 620px)')
    expect(styles).toContain('@media (prefers-reduced-motion: reduce)')
    expect(component).toContain('aria-labelledby="outcome-dashboard-title"')
    expect(component).toContain('role="alert"')
  })
})
