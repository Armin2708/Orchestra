import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const component = readFileSync(new URL('../web/src/OutcomeDashboard.tsx', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../web/src/outcome-dashboard.css', import.meta.url), 'utf8')

describe('outcome dashboard UI contract', () => {
  it('presents usage beside verified quality and accepted-delivery attribution', () => {
    for (const label of [
      'Tokens / accepted delivery', 'Cached-input ratio', 'First useful result',
      'Verified delivery', 'Evidence-gap rate', 'Rejection rate', 'Human-override rate',
      'Context and coordination', 'Duplicate exploration', 'Job attribution',
    ]) expect(component).toContain(label)
    expect(component).toContain('Token reduction counts only when accepted-delivery quality holds.')
  })

  it('refreshes from the event stream without introducing snapshot polling', () => {
    expect(component).toContain('new EventSource(streamUrl())')
    expect(component).not.toContain('setInterval')
    expect(component).toContain('stream.close()')
    expect(component).toContain("payload.board_id !== boardId || payload.type !== 'outcome_analytics'")
    expect(component).toContain('setDashboard(null)')
    expect(component).toContain('activeBoard.current !== requestedBoard')
    expect(component).toContain('dashboard.board_id !== boardId')
  })

  it('has responsive, focus-visible and reduced-motion behavior', () => {
    expect(styles).toContain(':focus-visible')
    expect(styles).toContain('@media (max-width: 620px)')
    expect(styles).toContain('@media (prefers-reduced-motion: reduce)')
    expect(component).toContain('aria-labelledby="outcome-dashboard-title"')
    expect(component).toContain('role="alert"')
  })
})
