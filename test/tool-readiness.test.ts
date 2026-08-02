import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  classifyCodexCliVersion,
  probeExecutableVersion,
  type VersionCommandOutcome,
} from '../src/environment-compatibility.js'
import { inspectProviderToolIntegrations } from '../src/tool-readiness.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('cold-safe provider doctor', () => {
  it('retries a cold timeout once under the 15 second bound and preserves the exact version', () => {
    const timeouts: number[] = []
    const outcomes: VersionCommandOutcome[] = [
      { stdout: '', exitCode: null, failure: 'timeout' },
      { stdout: '2.1.212 (Claude Code)\n', exitCode: 0, failure: null },
    ]
    const version = probeExecutableVersion('/safe/claude', (_command, timeoutMs) => {
      timeouts.push(timeoutMs)
      return outcomes.shift()!
    })
    expect(version).toBe('2.1.212 (Claude Code)')
    expect(timeouts).toEqual([3_000, 15_000])
  })

  it('distinguishes missing, timeout, overflow, failed, and unparseable evidence', () => {
    const classify = (outcome: VersionCommandOutcome) => classifyCodexCliVersion(
      probeExecutableVersion('/safe/codex', () => outcome),
    )
    expect(classify({ stdout: '', exitCode: null, failure: 'missing' }))
      .toMatchObject({ status: 'unsupported', probe_failure: 'missing' })
    expect(classify({ stdout: '', exitCode: null, failure: 'overflow' }))
      .toMatchObject({ status: 'unsupported', probe_failure: 'overflow' })
    expect(classify({ stdout: '', exitCode: 2, failure: 'failed' }))
      .toMatchObject({ status: 'unsupported', probe_failure: 'failed' })
    expect(classify({ stdout: 'development', exitCode: 0, failure: null }))
      .toMatchObject({ status: 'unsupported', probe_failure: 'unparseable' })
    let calls = 0
    const timedOut = classifyCodexCliVersion(probeExecutableVersion('/safe/codex', () => {
      calls += 1
      return { stdout: '', exitCode: null, failure: 'timeout' }
    }))
    expect(timedOut).toMatchObject({ status: 'unsupported', probe_failure: 'timeout' })
    expect(timedOut.detail).toMatch(/3 second fast probe.*15 second cold-start retry/)
    expect(calls).toBe(2)
  })
})

describe('hook and plugin doctor checks', () => {
  it('verifies genuine provider-specific configuration without exposing raw paths', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'orchestra-tool-doctor-'))
    roots.push(root)
    const settingsPath = path.join(root, '.codex', 'hooks.json')
    mkdirSync(path.dirname(settingsPath), { recursive: true })
    const events = [
      'session-start', 'post-tool-use', 'user-prompt-submit', 'stop',
      'permission-request', 'subagent-start', 'subagent-stop',
    ]
    writeFileSync(settingsPath, JSON.stringify({ hooks: Object.fromEntries(events.map((event) => [
      event.replace(/(^|-)(\w)/g, (_match, _prefix, value: string) => value.toUpperCase()),
      [{ hooks: [{ command: `orchestra hook ${event} --provider codex` }] }],
    ])) }))
    const plugin = path.join(root, '.codex-plugin')
    mkdirSync(plugin, { recursive: true })
    writeFileSync(path.join(plugin, 'plugin.json'), JSON.stringify({
      name: 'orchestra', version: '0.1.0', hooks: './hooks/codex-hooks.json',
    }))

    const checks = inspectProviderToolIntegrations({
      provider: 'codex', scope: 'project', roots: { cwd: root }, pluginRoot: root,
    })
    expect(checks).toEqual([
      expect.objectContaining({ id: 'codex-project-hooks', status: 'validated' }),
      expect.objectContaining({ id: 'codex-plugin', status: 'validated', version: '0.1.0' }),
    ])
    expect(JSON.stringify(checks)).not.toContain(root)
  })
})
