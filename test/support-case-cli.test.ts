import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Command } from 'commander'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerSupportCaseCommand } from '../src/support-case-cli.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('support-case CLI export', () => {
  it('requires explicit consent and writes only a digest-bound owner-only response', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-support-cli-'))
    roots.push(root)
    const requestFile = path.join(root, 'request.json')
    fs.writeFileSync(requestFile, JSON.stringify({ title: 'Safe request' }))
    const responseBytes = Buffer.from('{"schema_version":1}\n')
    const { createHash } = await import('node:crypto')
    const digest = createHash('sha256').update(responseBytes).digest('hex')
    const filename = `orchestra-support-case-2026-08-02T15-00-00-000Z-${digest.slice(0, 12)}.json`
    const logs: string[] = []
    const program = new Command().exitOverride().configureOutput({ writeErr: () => undefined })
    const ops = program.command('ops')
    registerSupportCaseCommand(ops, {
      ensureReady: async () => undefined,
      baseUrl: () => 'http://127.0.0.1:4111',
      ownerToken: () => 'owner-secret',
      log: (value) => logs.push(value),
      fetchImpl: async (_url, init) => {
        expect(init?.headers).toMatchObject({ authorization: 'Bearer owner-secret' })
        expect(JSON.parse(String(init?.body))).toMatchObject({
          title: 'Safe request',
          consent: 'I_CONSENT_TO_LOCAL_EXPORT_AND_REVIEW_BEFORE_SHARING',
        })
        return new Response(responseBytes, {
          status: 200,
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'content-disposition': `attachment; filename="${filename}"`,
            'x-content-sha256': digest,
          },
        })
      },
    })
    await program.parseAsync([
      'node', 'orchestra', 'ops', 'support-case', requestFile, root,
      '--consent-review-before-sharing',
    ])
    const destination = path.join(root, filename)
    expect(fs.readFileSync(destination)).toEqual(responseBytes)
    expect(fs.statSync(destination).mode & 0o777).toBe(0o600)
    expect(logs.join('\n')).toContain('"published": false')
  })

  it('rejects response digest drift without writing a file', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-support-cli-'))
    roots.push(root)
    const requestFile = path.join(root, 'request.json')
    fs.writeFileSync(requestFile, '{}')
    const program = new Command().exitOverride().configureOutput({ writeErr: () => undefined })
    const ops = program.command('ops')
    registerSupportCaseCommand(ops, {
      ensureReady: async () => undefined,
      baseUrl: () => 'http://127.0.0.1:4111',
      ownerToken: () => 'owner-secret',
      fetchImpl: async () => new Response('{}', {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'content-disposition': 'attachment; filename="orchestra-support-case-safe-aaaaaaaaaaaa.json"',
          'x-content-sha256': 'b'.repeat(64),
        },
      }),
    })
    await expect(program.parseAsync([
      'node', 'orchestra', 'ops', 'support-case', requestFile, root,
      '--consent-review-before-sharing',
    ])).rejects.toThrow('invalid support-case export')
    expect(fs.readdirSync(root)).toEqual(['request.json'])
  })

  it('opens the request descriptor-first and rejects a symlink request', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-support-cli-'))
    roots.push(root)
    const actual = path.join(root, 'actual.json')
    const linked = path.join(root, 'linked.json')
    fs.writeFileSync(actual, '{}')
    fs.symlinkSync(actual, linked)
    const program = new Command().exitOverride().configureOutput({ writeErr: () => undefined })
    const ops = program.command('ops')
    let fetched = false
    registerSupportCaseCommand(ops, {
      ensureReady: async () => undefined,
      baseUrl: () => 'http://127.0.0.1:4111',
      ownerToken: () => 'owner-secret',
      fetchImpl: async () => { fetched = true; return new Response() },
    })
    await expect(program.parseAsync([
      'node', 'orchestra', 'ops', 'support-case', linked, root,
      '--consent-review-before-sharing',
    ])).rejects.toThrow()
    expect(fetched).toBe(false)
  })

  it('bounds descriptor reads when the same request inode grows after fstat', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-support-cli-'))
    roots.push(root)
    const requestFile = path.join(root, 'request.json')
    fs.writeFileSync(requestFile, '{}')
    const originalFstat = fs.fstatSync.bind(fs)
    const fstat = vi.spyOn(fs, 'fstatSync').mockImplementationOnce(((descriptor) => {
      const initial = originalFstat(descriptor)
      fs.writeFileSync(requestFile, JSON.stringify({ title: 'x'.repeat(70 * 1024) }))
      return initial
    }) as typeof fs.fstatSync)
    const program = new Command().exitOverride().configureOutput({ writeErr: () => undefined })
    const ops = program.command('ops')
    let fetched = false
    registerSupportCaseCommand(ops, {
      ensureReady: async () => undefined,
      baseUrl: () => 'http://127.0.0.1:4111',
      ownerToken: () => 'owner-secret',
      fetchImpl: async () => { fetched = true; return new Response() },
    })
    try {
      await expect(program.parseAsync([
        'node', 'orchestra', 'ops', 'support-case', requestFile, root,
        '--consent-review-before-sharing',
      ])).rejects.toThrow('no larger than 64 KiB')
    } finally {
      fstat.mockRestore()
    }
    expect(fetched).toBe(false)
  })
})
