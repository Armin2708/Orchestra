import { expect, it } from 'vitest'
import { wakeMeter } from '../web/src/wake.js'

const AT = '2026-07-19T21:40:00.000Z'
const hhmm = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

it('hides the control entirely when nothing is paused', () => {
  expect(wakeMeter(0, AT, true)).toBeNull()
  expect(wakeMeter(0, null, false)).toBeNull()
})

it('shows the paused count and the scheduled auto-wake time', () => {
  const m = wakeMeter(3, AT, true)!
  expect(m.label).toBe('wake 3')
  expect(m.auto).toBe(`auto ${hhmm(AT)}`)
  expect(m.title).toContain('3 agents paused')
  expect(m.title).toContain(`Auto-wake fires ~${hhmm(AT)}`)
})

it('drops the auto time and says so when auto-wake is off or unscheduled', () => {
  const off = wakeMeter(2, AT, false)!
  expect(off.auto).toBeNull()
  expect(off.title).toContain('Auto-wake is off (ORCHESTRA_AUTOWAKE=0)')

  const unscheduled = wakeMeter(2, null, true)!
  expect(unscheduled.auto).toBeNull()
})

it('reads naturally for a single agent and reflects the in-flight wake', () => {
  expect(wakeMeter(1, AT, true)!.title).toContain('1 agent paused')
  expect(wakeMeter(1, AT, true)!.label).toBe('wake 1')
  expect(wakeMeter(1, AT, true, true)!.label).toBe('waking…')
})
