export type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void
  settled: boolean
}
export const deferred = <T>(): Deferred<T> => {
  let resolvePromise!: (value: T | PromiseLike<T>) => void
  let rejectPromise!: (reason?: unknown) => void
  const result: Deferred<T> = {
    promise: new Promise<T>((resolve, reject) => {
      resolvePromise = resolve
      rejectPromise = reject
    }),
    resolve: (value) => {
      if (result.settled) return
      result.settled = true
      resolvePromise(value)
    },
    reject: (reason) => {
      if (result.settled) return
      result.settled = true
      rejectPromise(reason)
    },
    settled: false,
  }
  return result
}

export class BoundedAsyncQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = []
  private readonly waiters: Array<Deferred<IteratorResult<T>>> = []
  private ended = false
  private failure: unknown

  constructor(readonly capacity = 4_096) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error('queue capacity must be a positive integer')
  }

  push(value: T): boolean {
    if (this.ended) return false
    const waiter = this.waiters.shift()
    if (waiter) {
      waiter.resolve({ value, done: false })
      return true
    }
    const retained = this.values.length < this.capacity
    if (!retained) this.values.shift()
    this.values.push(value)
    return retained
  }

  close(error?: unknown): void {
    if (this.ended) return
    this.ended = true
    this.failure = error
    for (const waiter of this.waiters.splice(0)) {
      if (error === undefined) waiter.resolve({ value: undefined, done: true })
      else waiter.reject(error)
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    let returned = false
    return {
      next: async () => {
        if (returned) return { value: undefined, done: true }
        const value = this.values.shift()
        if (value !== undefined) return { value, done: false }
        if (this.ended) {
          if (this.failure !== undefined) throw this.failure
          return { value: undefined, done: true }
        }
        const waiter = deferred<IteratorResult<T>>()
        this.waiters.push(waiter)
        return waiter.promise
      },
      return: async () => {
        returned = true
        return { value: undefined, done: true }
      },
    }
  }
}
