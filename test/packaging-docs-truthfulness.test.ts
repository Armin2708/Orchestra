import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (relativePath: string) => readFileSync(path.join(root, relativePath), 'utf8')

const files = [
  'README.md',
  'docs/operator-preview.md',
  'docs/remote-preview.md',
  'docs/support-preview.md',
] as const

describe('packaging documentation truthfulness', () => {
  it('does not advertise the unsafe remote bootstrap as secure pairing', () => {
    const readme = read('README.md')
    const remote = read('docs/remote-preview.md')
    const cli = read('src/cli.ts')

    expect(readme).not.toContain('secure tunnel + QR pairing')
    expect(readme).toContain('not secure device pairing')
    expect(readme).not.toContain('tear the tunnel down')
    expect(cli).not.toContain('expose the board over a secure tunnel and pair your phone')
    expect(cli).not.toContain('tear the tunnel down')
    expect(cli).not.toContain('tunnel down')
    expect(cli).toContain('not secure device pairing')
    expect(cli).toContain('remote stop requested')
    expect(remote).toContain('reusable master operator bearer')
    expect(remote.replace(/\s+/g, ' '))
      .toContain('token bootstrap, not device enrollment or secure pairing')
    expect(remote).toContain('no per-device revocation')
    expect(remote).toContain('`REM-GATE` remains open')
  })

  it('keeps state retirement recoverable and distinguishes local telemetry', () => {
    const readme = read('README.md')
    const operator = read('docs/operator-preview.md')

    expect(readme).not.toMatch(/\brm\s+-rf\s+(?:~\/\.orchestra|["']?\$ORCHESTRA_HOME)/i)
    expect(readme).not.toContain('no telemetry of any kind')
    expect(readme).not.toContain('Fully local — no accounts, no cloud, no telemetry')
    expect(readme).toContain('local injected-context telemetry')
    expect(readme).toContain('https://api.anthropic.com/api/oauth/usage')
    expect(operator).toContain('Claude Code OAuth credential')
    expect(operator).toContain('Hooks can auto-start the daemon')
    expect(operator).toContain('recorded daemon PID')
    expect(operator).toContain('exact daemon process has exited')
    expect(operator).toContain('proceed only after it remains unreachable')
    expect(readme).toContain('test ! -e "$HOME/.orchestra.backup" &&')
    expect(operator).toContain('Do not use a recursive delete as an uninstall step.')

    for (const statePath of [
      'orchestra.db',
      'orchestra.db-wal',
      'orchestra.db-shm',
      'daemon.pid',
      '`token`',
      '`agent-token`',
      'vapid.json',
      'sessions/*.json',
      'sessions/codex/*.json',
      'remote.json',
      'cloudflared.log',
    ]) {
      expect(operator, `missing state inventory entry ${statePath}`).toContain(statePath)
    }
  })

  it('states that support has no safe diagnostics bundle', () => {
    const support = read('docs/support-preview.md')

    expect(support).toContain('no SLA')
    expect(support).toContain('no implemented diagnostics-bundle command')
    expect(support).toContain('Do not attach or paste')
    expect(support).toContain('do not satisfy diagnostics-bundle')
  })

  it('ships the local documentation linked from the packaged README', () => {
    const manifest = JSON.parse(read('package.json')) as { files?: string[] }
    const packaged = new Set(manifest.files ?? [])

    for (const relativePath of [
      'docs/agent-os.md',
      'docs/codex.md',
      'docs/delivery-trackbook.md',
      'docs/operator-preview.md',
      'docs/remote-mobile-threat-control-matrix.json',
      'docs/remote-mobile-threat-model.md',
      'docs/remote-preview.md',
      'docs/support-preview.md',
      'docs/supported-environments.md',
    ]) {
      expect(packaged, `${relativePath} is absent from the package allowlist`).toContain(relativePath)
    }
  })

  it('keeps every local link in the edited documentation resolvable', () => {
    const markdownLink = /\[[^\]]+\]\(([^)]+)\)/g

    for (const relativePath of files) {
      const source = read(relativePath)
      for (const match of source.matchAll(markdownLink)) {
        const target = match[1].trim()
        if (!target || /^(?:https?:|mailto:|#)/.test(target)) continue
        const fileTarget = decodeURIComponent(target.split('#', 1)[0])
        const resolved = path.resolve(path.dirname(path.join(root, relativePath)), fileTarget)
        expect(existsSync(resolved), `${relativePath} has a missing link target: ${target}`).toBe(true)
      }
    }
  })
})
