import fs from 'node:fs'
import path from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

const web = path.resolve('web')
const read = (file: string) => fs.readFileSync(path.join(web, file), 'utf8')

type WorkerRequest = { url: string; method: string; mode: string }

const loadWorker = (options: {
  cacheNames?: string[]
  cachedUrls?: string[]
  offline?: boolean
} = {}) => {
  const listeners = new Map<string, Array<(event: any) => void>>()
  const deletedCaches: string[] = []
  const cacheMatches: Array<string | WorkerRequest> = []
  const cacheWrites: Array<string | WorkerRequest> = []
  const fetchCalls: WorkerRequest[] = []
  const importedScripts: string[] = []
  const cachedUrls = new Set(options.cachedUrls ?? [])
  const self = {
    addEventListener(type: string, listener: (event: any) => void) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener])
    },
    skipWaiting: async () => undefined,
    clients: { claim: async () => undefined },
  }
  const caches = {
    open: async () => ({
      addAll: async () => undefined,
      put: async (request: string | WorkerRequest) => { cacheWrites.push(request) },
    }),
    keys: async () => options.cacheNames ?? [],
    delete: async (key: string) => { deletedCaches.push(key); return true },
    match: async (request: string | WorkerRequest) => {
      cacheMatches.push(request)
      const url = typeof request === 'string' ? request : request.url
      return cachedUrls.has(url) ? new Response(`cached:${url}`, { status: 200 }) : undefined
    },
  }
  const fetch = async (request: WorkerRequest) => {
    fetchCalls.push(request)
    if (options.offline) throw new Error('fixture network offline')
    return new Response(`network:${request.url}`, { status: 200 })
  }
  runInNewContext(read('public/sw.js'), {
    self,
    caches,
    fetch,
    importScripts: (script: string) => { importedScripts.push(script) },
    location: { origin: 'https://orchestra.example' },
    URL,
    Promise,
    Response,
  })

  const dispatchFetch = async (request: WorkerRequest) => {
    const handler = listeners.get('fetch')?.[0]
    if (!handler) throw new Error('shipped service worker has no fetch handler')
    let responsePromise: Promise<Response | undefined> | undefined
    let respondWithCalls = 0
    handler({
      request,
      respondWith(value: Promise<Response | undefined>) {
        respondWithCalls += 1
        responsePromise = Promise.resolve(value)
      },
    })
    const response = responsePromise ? await responsePromise : undefined
    await Promise.resolve()
    return { respondWithCalls, response }
  }

  const dispatchWaitable = async (type: string, data?: unknown) => {
    const waits: Promise<unknown>[] = []
    for (const handler of listeners.get(type) ?? []) {
      handler({ data, waitUntil: (value: Promise<unknown>) => waits.push(Promise.resolve(value)) })
    }
    await Promise.all(waits)
  }

  return {
    cacheMatches,
    cacheWrites,
    deletedCaches,
    dispatchFetch,
    dispatchWaitable,
    fetchCalls,
    importedScripts,
  }
}

describe('installable PWA', () => {
  it('ships a valid manifest and every declared icon', () => {
    const manifest = JSON.parse(read('public/manifest.webmanifest'))
    expect(manifest.name).toContain('Orchestra')
    expect(manifest.display).toBe('standalone')
    expect(manifest.start_url).toBe('/')
    expect(manifest.icons.length).toBeGreaterThanOrEqual(3)
    for (const icon of manifest.icons) {
      expect(fs.statSync(path.join(web, 'public', icon.src)).size).toBeGreaterThan(0)
    }
  })

  it('links the manifest, registers the shell worker, and imports push handlers', () => {
    expect(read('index.html')).toContain('manifest.webmanifest')
    expect(read('src/main.tsx')).toContain("serviceWorker.register('/sw.js')")
    expect(loadWorker().importedScripts).toEqual(['/sw-push.js'])
  })

  it('leaves authenticated board and event GETs entirely outside the worker', async () => {
    for (const pathname of ['/api/v1/boards', '/api/v1/events']) {
      const worker = loadWorker()
      const result = await worker.dispatchFetch({
        url: `https://orchestra.example${pathname}`,
        method: 'GET',
        mode: 'cors',
      })
      expect(result.respondWithCalls).toBe(0)
      expect(worker.fetchCalls).toEqual([])
      expect(worker.cacheMatches).toEqual([])
      expect(worker.cacheWrites).toEqual([])
    }
  })

  it('does not intercept API mutations or cross-origin requests', async () => {
    const worker = loadWorker()
    expect((await worker.dispatchFetch({
      url: 'https://orchestra.example/api/v1/boards', method: 'POST', mode: 'cors',
    })).respondWithCalls).toBe(0)
    expect((await worker.dispatchFetch({
      url: 'https://other.example/app.js', method: 'GET', mode: 'cors',
    })).respondWithCalls).toBe(0)
    expect(worker.fetchCalls).toEqual([])
    expect(worker.cacheMatches).toEqual([])
    expect(worker.cacheWrites).toEqual([])
  })

  it('keeps navigation network-first with an offline shell fallback', async () => {
    const online = loadWorker()
    const navigation = { url: 'https://orchestra.example/board/7', method: 'GET', mode: 'navigate' }
    const onlineResult = await online.dispatchFetch(navigation)
    expect(onlineResult.respondWithCalls).toBe(1)
    expect(await onlineResult.response?.text()).toBe(`network:${navigation.url}`)
    expect(online.fetchCalls).toEqual([navigation])
    expect(online.cacheWrites).toEqual(['/'])

    const offline = loadWorker({ offline: true, cachedUrls: ['/'] })
    const offlineResult = await offline.dispatchFetch(navigation)
    expect(offlineResult.respondWithCalls).toBe(1)
    expect(await offlineResult.response?.text()).toBe('cached:/')
    expect(offline.cacheMatches).toEqual(['/'])
  })

  it('keeps static assets cache-first and writes only successful misses', async () => {
    const cachedUrl = 'https://orchestra.example/assets/app-cached.js'
    const cached = loadWorker({ cachedUrls: [cachedUrl] })
    const cachedRequest = { url: cachedUrl, method: 'GET', mode: 'cors' }
    expect((await cached.dispatchFetch(cachedRequest)).respondWithCalls).toBe(1)
    expect(cached.fetchCalls).toEqual([])
    expect(cached.cacheWrites).toEqual([])

    const fresh = loadWorker()
    const freshRequest = {
      url: 'https://orchestra.example/assets/app-fresh.js', method: 'GET', mode: 'cors',
    }
    expect((await fresh.dispatchFetch(freshRequest)).respondWithCalls).toBe(1)
    expect(fresh.fetchCalls).toEqual([freshRequest])
    expect(fresh.cacheWrites).toEqual([freshRequest])
  })

  it('deletes legacy API caches during activation and device-data purge', async () => {
    const activation = loadWorker({
      cacheNames: ['orchestra-shell-v3', 'orchestra-shell-v2', 'orchestra-api-v1'],
    })
    await activation.dispatchWaitable('activate')
    expect(activation.deletedCaches).toEqual(['orchestra-shell-v2', 'orchestra-api-v1'])

    const purge = loadWorker({
      cacheNames: ['orchestra-shell-v3', 'orchestra-api-v1', 'unrelated-cache'],
    })
    await purge.dispatchWaitable('message', { type: 'PURGE_DEVICE_DATA' })
    expect(purge.deletedCaches).toEqual(['orchestra-shell-v3', 'orchestra-api-v1'])
  })

  it('ships phone install metadata without a native-app credential handoff', () => {
    const manifest = JSON.parse(read('public/manifest.webmanifest'))
    expect(manifest.prefer_related_applications).toBe(false)
    expect(manifest.display_override).toContain('standalone')
    expect(manifest.shortcuts.map((shortcut: { name: string }) => shortcut.name)).toEqual(['Messages', 'Needs You'])
  })
})
