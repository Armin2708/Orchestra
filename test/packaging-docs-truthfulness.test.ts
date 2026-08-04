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
  it('documents private password bootstrap and public ticket pairing without reviving master-token bootstrap', () => {
    const readme = read('README.md')
    const remote = read('docs/remote-preview.md')
    const cli = read('src/cli.ts')

    expect(readme).toContain('private password sign-in or scoped pairing')
    expect(readme).toContain('Public Cloudflare access always')
    expect(readme).toContain('owner-password sign-in is rejected on public tunnels')
    expect(readme).toContain('scoped DeviceSession pairing')
    expect(readme).not.toContain('tear the tunnel down')
    expect(cli).not.toContain('expose the board over a secure tunnel and pair your phone')
    expect(cli).not.toContain('tear the tunnel down')
    expect(cli).not.toContain('tunnel down')
    expect(cli).toContain('secure device pairing')
    expect(cli).toContain('privatePasswordBootstrapAllowed(state)')
    expect(cli).toContain('remote stop requested')
    expect(remote).toContain('never contains the master operator token')
    expect(remote).toContain('Public Cloudflare origins')
    expect(remote).toContain('individually revocable')
    expect(remote).toContain('REVOKE_ALL_REMOTE_AUTHORITY')
    expect(remote).toContain('`REM-017` and `REM-GATE` remain open')
    expect(remote).not.toContain('`REM-GATE` is satisfied')
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
      'vapid-reference.json',
      'sessions/*.json',
      'sessions/codex/*.json',
      'remote.json',
      'cloudflared.log',
    ]) {
      expect(operator, `missing state inventory entry ${statePath}`).toContain(statePath)
    }
  })

  it('documents the allowlisted diagnostics bundle without calling it automatically safe', () => {
    const support = read('docs/support-preview.md')

    expect(support).toContain('no SLA')
    expect(support).toContain('orchestra ops diagnostics')
    expect(support).toContain('Decode and review it before sharing')
    expect(support).toContain('Do not attach or paste')
    expect(support).toContain('does not make the following safe')
  })

  it('ships the local documentation linked from the packaged README', () => {
    const manifest = JSON.parse(read('package.json')) as { files?: string[] }
    const packaged = new Set(manifest.files ?? [])

    expect(packaged).not.toContain('docs')
    expect([...packaged].some((entry) => entry.startsWith('docs/checkpoints/'))).toBe(false)
    expect([...packaged].some((entry) => entry.includes('competitor-teardown'))).toBe(false)
    expect([...packaged].some((entry) => entry.includes('value-audit'))).toBe(false)
    expect([...packaged].some((entry) => entry.includes('north-star-delivery-program'))).toBe(false)

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
