import { vi } from 'vitest'

type HookModule = {
  runHook(event: string, requestedProvider?: string): Promise<void>
}

export function preserveProcessEnv(keys: readonly string[]): () => void {
  const previous = new Map(keys.map((key) => [key, process.env[key]]))
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

export async function runHookToCompletion(
  hooks: HookModule,
  event: string,
  requestedProvider?: string,
): Promise<void> {
  // runHook schedules its deadline synchronously before starting work. Replace
  // only that first timer with an inert handle so tests await the real work and
  // cannot let a timed-out invocation write into the next test's stdout spy.
  const deadline = vi.spyOn(globalThis, 'setTimeout')
  deadline.mockImplementationOnce((() => undefined) as typeof setTimeout)
  try {
    await hooks.runHook(event, requestedProvider)
  } finally {
    deadline.mockRestore()
  }
}
