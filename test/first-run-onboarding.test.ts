import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  applyFirstRunPlan,
  assertFirstRunConfigCompatible,
  buildFirstRunPlan,
} from '../src/first-run-onboarding.js'

describe('first-run onboarding domain', () => {
  it('uses safe defaults and preserves provider support truth', () => {
    const plan = buildFirstRunPlan({
      project_root: '/workspace/project',
      provider_id: 'codex',
    }, { directoryExists: () => true })

    expect(plan.defaults).toEqual({
      bind_host: '127.0.0.1',
      remote_access: 'off',
      terminal_remote_write: 'off',
      telemetry: 'off',
      usage_priced_api_fallback: 'off',
      destructive_cleanup: 'manual_only',
      workspace_mode: 'isolated_worktree',
    })
    expect(plan.provider).toMatchObject({
      id: 'codex',
      release_state: 'candidate',
      mode: 'native_subscription',
      billing_mode: 'personal_subscription',
    })
    expect(plan.ready_for_managed_launch).toBe(false)
    expect(plan.blockers.map((blocker) => blocker.code)).toContain(
      'provider_not_release_supported',
    )
  })

  it('requires explicit API billing consent and stays blocked without a direct API runtime', () => {
    const unacknowledged = buildFirstRunPlan({
      project_root: '/workspace/project',
      provider_id: 'claude',
      execution_mode: 'provider_api',
    }, { directoryExists: () => true })
    expect(unacknowledged.blockers.map((blocker) => blocker.code)).toEqual(
      expect.arrayContaining([
        'provider_api_consent_required',
        'provider_api_not_implemented',
      ]),
    )

    const acknowledged = buildFirstRunPlan({
      project_root: '/workspace/project',
      provider_id: 'claude',
      execution_mode: 'provider_api',
      acknowledge_usage_priced_api: true,
    }, { directoryExists: () => true })
    expect(acknowledged.blockers.map((blocker) => blocker.code)).not.toContain(
      'provider_api_consent_required',
    )
    expect(acknowledged.blockers.map((blocker) => blocker.code)).toContain(
      'provider_api_not_implemented',
    )
  })

  it('persists an owner-only compatible config and delegates only explicit hooks', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-onboarding-'))
    const configPath = path.join(root, 'state', 'onboarding.json')
    const installProviderHooks = vi.fn()
    const plan = buildFirstRunPlan({
      project_root: root,
      provider_id: 'codex',
      hook_scope: 'project',
      telemetry: 'redacted',
    })

    const config = applyFirstRunPlan(plan, {
      configPath,
      installProviderHooks,
      now: () => '2026-08-02T12:00:00.000Z',
    })

    expect(installProviderHooks).toHaveBeenCalledWith('project', {
      provider: 'codex',
      roots: { cwd: root },
    })
    expect(assertFirstRunConfigCompatible(
      JSON.parse(fs.readFileSync(configPath, 'utf8')),
    )).toEqual(config)
    expect(fs.statSync(configPath).mode & 0o777).toBe(0o600)
    expect(fs.readFileSync(configPath, 'utf8')).not.toMatch(/api[_-]?key|token|secret/i)
  })

  it('fails closed on unknown config schema and invalid project selection', () => {
    expect(() => assertFirstRunConfigCompatible({ schema_version: 2 }))
      .toThrow('unsupported first-run configuration schema')
    const plan = buildFirstRunPlan({
      project_root: 'relative/project',
      provider_id: 'kimi',
    }, { directoryExists: () => false })
    expect(plan.blockers.map((blocker) => blocker.code)).toContain('project_not_absolute')

    const unsupportedHooks = buildFirstRunPlan({
      project_root: '/workspace/project',
      provider_id: 'qwen',
      hook_scope: 'global',
    }, { directoryExists: () => true })
    expect(unsupportedHooks.blockers.map((blocker) => blocker.code))
      .toContain('hooks_not_supported')
  })
})
