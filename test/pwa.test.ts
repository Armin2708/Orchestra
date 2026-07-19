import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const web = path.resolve('web')
const read = (file: string) => fs.readFileSync(path.join(web, file), 'utf8')

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

  it('links the manifest, registers the worker, and keeps SSE out of its cache', () => {
    expect(read('index.html')).toContain('manifest.webmanifest')
    expect(read('src/main.tsx')).toContain("serviceWorker.register('/sw.js')")
    const worker = read('public/sw.js')
    expect(worker).toContain("importScripts('/sw-push.js')")
    expect(worker).toContain("endsWith('/events')")
    expect(worker).toContain('SSE — never intercept')
  })
})
