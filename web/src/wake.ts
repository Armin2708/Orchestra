// display logic for the system meter's wake-all control (#62), kept pure so it can be
// tested without a DOM — the component is a thin shell over this
export type WakeMeter = { label: string; auto: string | null; title: string }

const hhmm = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

export function wakeMeter(
  paused: number,
  autowakeAt: string | null | undefined,
  autowakeEnabled: boolean | undefined,
  busy = false,
): WakeMeter | null {
  if (!paused) return null // nothing paused → the control stays out of the meter entirely
  const auto = autowakeEnabled && autowakeAt ? hhmm(autowakeAt) : null
  return {
    label: busy ? 'waking…' : `wake ${paused}`,
    auto: auto ? `auto ${auto}` : null,
    title: `${paused} agent${paused === 1 ? '' : 's'} paused by Claude usage limits — sessions and tickets intact.` +
      (auto ? ` Auto-wake fires ~${auto}, after the window resets.` : ' Auto-wake is off (ORCHESTRA_AUTOWAKE=0).') +
      ' Click to wake all now.',
  }
}
