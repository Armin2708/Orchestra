export type RefreshCycle = {
  succeeded: boolean
  queued: boolean
  visible: boolean
}

export type SingleFlightRefreshOptions<T> = {
  load: () => Promise<T>
  onStart?: (visible: boolean) => void
  onSuccess: (value: T) => void
  onFailure: (reason: unknown) => void
  onSettled?: (visible: boolean) => void
  onCycle?: (cycle: RefreshCycle) => void
}

export function createSingleFlightRefresh<T>(options: SingleFlightRefreshOptions<T>) {
  let disposed = false
  let running = false
  let queued = false
  let queuedVisible = false

  const run = async (visible: boolean) => {
    running = true
    let succeeded = false
    try {
      const value = await options.load()
      if (disposed) return
      options.onSuccess(value)
      succeeded = true
    } catch (reason) {
      if (disposed) return
      options.onFailure(reason)
    } finally {
      if (disposed) return
      running = false
      options.onSettled?.(visible)
      const continueQueued = queued
      const nextVisible = queuedVisible
      queued = false
      queuedVisible = false
      options.onCycle?.({ succeeded, queued: continueQueued, visible })
      if (continueQueued) void run(nextVisible)
    }
  }

  return {
    request(visible = false) {
      if (disposed) return
      options.onStart?.(visible)
      if (running) {
        queued = true
        queuedVisible ||= visible
        return
      }
      void run(visible)
    },
    dispose() {
      disposed = true
      queued = false
      queuedVisible = false
    },
  }
}
