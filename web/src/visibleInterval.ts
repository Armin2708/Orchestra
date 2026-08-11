/**
 * setInterval that stops while the tab is hidden and catches up on the way back.
 *
 * Every view in this app polls the daemon on its own timer — the drawer once a second
 * per open agent, plus the board, workspace, timeline and inbox tickers. Browsers keep
 * all of them running in a background tab, so a laptop with the board left open in some
 * other window was paying full daemon CPU for frames nobody could see.
 *
 * Returns a cleanup that stops the timer and unsubscribes.
 */
export function visibleInterval(fn: () => void, ms: number): () => void {
  let timer: number | undefined
  const start = () => { if (timer === undefined) timer = window.setInterval(fn, ms) }
  const stop = () => {
    if (timer === undefined) return
    window.clearInterval(timer)
    timer = undefined
  }
  const onVisibility = () => {
    if (document.hidden) { stop(); return }
    fn() // returning to the tab shows fresh state immediately, not one interval later
    start()
  }
  if (!document.hidden) start()
  document.addEventListener('visibilitychange', onVisibility)
  return () => { stop(); document.removeEventListener('visibilitychange', onVisibility) }
}
