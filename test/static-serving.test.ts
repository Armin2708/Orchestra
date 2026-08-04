import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../src/db.js'
import { buildServer } from '../src/server.js'
import { compressDist } from '../web/scripts/compress-dist.mjs'

const servers: Array<ReturnType<typeof buildServer>> = []
let dist: string

beforeEach(() => {
  dist = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-dist-'))
  fs.mkdirSync(path.join(dist, 'assets'))
  fs.writeFileSync(path.join(dist, 'index.html'), `<html>${'orchestra '.repeat(200)}</html>`)
  fs.writeFileSync(path.join(dist, 'sw.js'), `// worker\n${'self.x = 1;'.repeat(200)}`)
  fs.writeFileSync(path.join(dist, 'assets', 'index-AbC123xy.js'), `console.log("app");${'const pad = 0;'.repeat(200)}`)
  fs.writeFileSync(path.join(dist, 'assets', 'icon.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
})

afterEach(async () => {
  fs.rmSync(dist, { recursive: true, force: true })
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

const fixture = () => {
  const server = buildServer(openDb(':memory:'), undefined, { token: 'owner-secret', webDist: dist })
  servers.push(server)
  return server
}

describe('compressDist', () => {
  it('writes .br and .gz siblings for compressible files and skips binaries', () => {
    compressDist(dist)
    expect(fs.existsSync(path.join(dist, 'assets', 'index-AbC123xy.js.br'))).toBe(true)
    expect(fs.existsSync(path.join(dist, 'assets', 'index-AbC123xy.js.gz'))).toBe(true)
    expect(fs.existsSync(path.join(dist, 'index.html.gz'))).toBe(true)
    expect(fs.existsSync(path.join(dist, 'assets', 'icon.png.gz'))).toBe(false)
    const raw = fs.readFileSync(path.join(dist, 'assets', 'index-AbC123xy.js'))
    expect(zlib.gunzipSync(fs.readFileSync(path.join(dist, 'assets', 'index-AbC123xy.js.gz')))).toEqual(raw)
    expect(zlib.brotliDecompressSync(fs.readFileSync(path.join(dist, 'assets', 'index-AbC123xy.js.br')))).toEqual(raw)
  })

  it('is idempotent and never compresses its own outputs', () => {
    compressDist(dist)
    compressDist(dist)
    expect(fs.existsSync(path.join(dist, 'assets', 'index-AbC123xy.js.gz.gz'))).toBe(false)
    expect(fs.existsSync(path.join(dist, 'assets', 'index-AbC123xy.js.br.gz'))).toBe(false)
  })
})

describe('static serving', () => {
  it('serves hashed assets with an immutable long-lived cache-control', async () => {
    const res = await fixture().inject({ method: 'GET', url: '/assets/index-AbC123xy.js' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable')
  })

  it('serves the shell and worker with no-cache so updates land on next load', async () => {
    const server = fixture()
    for (const url of ['/', '/sw.js']) {
      const res = await server.inject({ method: 'GET', url })
      expect(res.statusCode).toBe(200)
      expect(res.headers['cache-control']).toBe('no-cache')
    }
  })

  it('serves precompressed brotli and gzip variants when the client accepts them', async () => {
    compressDist(dist)
    const server = fixture()
    const br = await server.inject({ method: 'GET', url: '/assets/index-AbC123xy.js', headers: { 'accept-encoding': 'br' } })
    expect(br.headers['content-encoding']).toBe('br')
    const gz = await server.inject({ method: 'GET', url: '/assets/index-AbC123xy.js', headers: { 'accept-encoding': 'gzip' } })
    expect(gz.headers['content-encoding']).toBe('gzip')
    const plain = await server.inject({ method: 'GET', url: '/assets/index-AbC123xy.js', headers: { 'accept-encoding': 'identity' } })
    expect(plain.headers['content-encoding']).toBeUndefined()
    expect(plain.body).toContain('console.log("app")')
  })
})
