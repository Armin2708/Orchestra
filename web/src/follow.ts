// Auto-follow intent for the agent terminal, computed at user-scroll time (#48).
// Content growth fires no scroll event, so intent survives any size of append — the
// old post-render distance check silently unpinned on big ones. The hysteresis band
// keeps iOS rubber-band bounces and sub-threshold drags from flipping state.
export const followIntent = (distance: number, prev: boolean): boolean =>
  distance < 40 ? true : distance > 120 ? false : prev
