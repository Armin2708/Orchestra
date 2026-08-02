import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const component = readFileSync(new URL('../web/src/OutcomeDashboard.tsx', import.meta.url), 'utf8')
const app = readFileSync(new URL('../web/src/App.tsx', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../web/src/outcome-dashboard.css', import.meta.url), 'utf8')

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

  it('refreshes from the event stream without introducing snapshot polling', () => {
    expect(component).toContain('new EventSource(streamUrl())')
    expect(component).not.toContain('setInterval')
    expect(component).toContain('stream.close()')
    expect(component).toContain("payload.board_id !== boardId || payload.type !== 'outcome_analytics'")
    expect(component).toContain('setDashboard(null)')
    expect(component).toContain('activeBoard.current !== requestedBoard')
    expect(component).toContain('dashboard.board_id !== boardId')
    const dashboardSetup = component.slice(
      component.indexOf('useEffect(() => {'),
      component.indexOf('const qualityTone'),
    )
    expect(dashboardSetup.indexOf('new EventSource(streamUrl())'))
      .toBeLessThan(dashboardSetup.indexOf('void requestRefresh()'))
    expect(dashboardSetup).toContain('stream.onopen = () =>')
    expect(dashboardSetup).toContain('refreshQueued = true')
    expect(dashboardSetup).toContain('if (!succeeded && retry === undefined)')
    expect(dashboardSetup).toContain('let disposed = false')
    expect(dashboardSetup).toContain('disposed = true')
    const dashboardAfterLoad = dashboardSetup.slice(
      dashboardSetup.indexOf('const succeeded = await load(!initialRequest)'),
    )
    expect(dashboardAfterLoad.indexOf('if (disposed) return'))
      .toBeLessThan(dashboardAfterLoad.indexOf('if (!succeeded && retry === undefined)'))
    expect(dashboardSetup).toContain('window.clearTimeout(initialFallback)')
    expect(dashboardSetup).toContain('if (retry !== undefined) window.clearTimeout(retry)')
    expect(app).toContain('new EventSource(streamUrl())')
    expect(app).not.toContain('setInterval(refresh, 30_000)')
    const setup = app.slice(app.indexOf('// a single stream for everything'), app.indexOf('if (needsAuth) return <Login'))
    expect(setup.indexOf('new EventSource(streamUrl())'))
      .toBeLessThan(setup.indexOf('void requestRefresh()'))
    expect(setup).toContain('es.onopen = () =>')
    expect(setup).toContain('void requestRefresh()')
    expect(setup).toContain('if (!succeeded && retry === undefined)')
    expect(setup).toContain('retry = window.setTimeout(() =>')
    expect(setup).toContain('refreshQueued = true')
    expect(setup).toContain('let disposed = false')
    expect(setup).toContain('disposed = true')
    const afterRefresh = setup.slice(setup.indexOf('const succeeded = await refresh()'))
    expect(afterRefresh.indexOf('if (disposed) return'))
      .toBeLessThan(afterRefresh.indexOf('if (!succeeded && retry === undefined)'))
    expect(setup).toContain('refreshQueued = false')
    expect(setup).toContain('clearTimeout(initialFallback)')
    expect(setup).toContain('if (retry !== undefined) clearTimeout(retry)')
  })

  it('has responsive, focus-visible and reduced-motion behavior', () => {
    expect(styles).toContain(':focus-visible')
    expect(styles).toContain('@media (max-width: 620px)')
    expect(styles).toContain('@media (prefers-reduced-motion: reduce)')
    expect(component).toContain('aria-labelledby="outcome-dashboard-title"')
    expect(component).toContain('role="alert"')
  })
})
