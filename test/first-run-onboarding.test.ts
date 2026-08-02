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
  const releaseReadyPlan = (root: string, hooks: 'off' | 'project' = 'off') => {
    const candidate = buildFirstRunPlan({
      project_root: root,
      provider_id: 'codex',
      hook_scope: hooks,
      telemetry: 'redacted',
    })
    return {
      ...candidate,
      provider: {
        ...candidate.provider,
        release_state: 'validated' as const,
        support_state: 'supported' as const,
        support_reason: null,
      },
      hooks: { ...candidate.hooks, capability_state: 'supported' as const },
      blockers: [],
      ready_for_managed_launch: true,
    }
  }

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

  it('persists an owner-only compatible config and delegates hooks only for a release-ready plan', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-onboarding-'))
    const configPath = path.join(root, 'state', 'onboarding.json')
    const installProviderHooks = vi.fn()
    const plan = releaseReadyPlan(root, 'project')

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

  it('rejects every candidate blocker before config or hook side effects', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-onboarding-blocked-'))
    const configPath = path.join(root, 'state', 'onboarding.json')
    const installProviderHooks = vi.fn()
    const candidate = buildFirstRunPlan({
      project_root: root,
      provider_id: 'codex',
      hook_scope: 'project',
    })
    expect(() => applyFirstRunPlan(candidate, { configPath, installProviderHooks }))
      .toThrow('no configuration or hooks were changed')
    expect(installProviderHooks).not.toHaveBeenCalled()
    expect(fs.existsSync(configPath)).toBe(false)

    const forged = {
      ...candidate,
      blockers: [],
      ready_for_managed_launch: true,
    }
    expect(() => applyFirstRunPlan(forged, { configPath, installProviderHooks }))
      .toThrow('not release-validated')
    expect(installProviderHooks).not.toHaveBeenCalled()

    const unknownHooks = {
      ...releaseReadyPlan(root, 'project'),
      hooks: { scope: 'project' as const, capability_state: 'unknown' as const },
    }
    expect(() => applyFirstRunPlan(unknownHooks, { configPath, installProviderHooks }))
      .toThrow('hook capability is not supported')
    expect(fs.existsSync(configPath)).toBe(false)
  })

  it('never activates hooks when config persistence fails first', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-onboarding-write-fail-'))
    const notDirectory = path.join(root, 'not-a-directory')
    fs.writeFileSync(notDirectory, 'occupied')
    const installProviderHooks = vi.fn()
    expect(() => applyFirstRunPlan(releaseReadyPlan(root, 'project'), {
      configPath: path.join(notDirectory, 'onboarding.json'),
      installProviderHooks,
    })).toThrow()
    expect(installProviderHooks).not.toHaveBeenCalled()

    const invalidConfig = path.join(root, 'invalid-onboarding.json')
    fs.writeFileSync(invalidConfig, '{"api_token":"do-not-overwrite"}\n')
    const original = fs.readFileSync(invalidConfig, 'utf8')
    expect(() => applyFirstRunPlan(releaseReadyPlan(root, 'project'), {
      configPath: invalidConfig,
      installProviderHooks,
    })).toThrow('forbidden sensitive field')
    expect(fs.readFileSync(invalidConfig, 'utf8')).toBe(original)
    expect(installProviderHooks).not.toHaveBeenCalled()
  })

  it('rolls the verified config back when release-ready hook setup fails', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-onboarding-rollback-'))
    const configPath = path.join(root, 'state', 'onboarding.json')
    const previous = releaseReadyPlan(root)
    applyFirstRunPlan(previous, {
      configPath,
      now: () => '2026-08-02T08:00:00.000Z',
    })
    const previousBytes = fs.readFileSync(configPath, 'utf8')
    const next = releaseReadyPlan(root, 'project')
    expect(() => applyFirstRunPlan(next, {
      configPath,
      now: () => '2026-08-02T09:00:00.000Z',
      installProviderHooks: () => { throw new Error('hook write failed') },
    })).toThrow('hook write failed')
    expect(fs.readFileSync(configPath, 'utf8')).toBe(previousBytes)
  })

  it('fails closed on unknown config schema and invalid project selection', () => {
    expect(() => assertFirstRunConfigCompatible({ schema_version: 2 }))
      .toThrow('unknown or missing fields')
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

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-onboarding-strict-'))
    const config = applyFirstRunPlan(releaseReadyPlan(root), {
      configPath: path.join(root, 'onboarding.json'),
      now: () => '2026-08-02T09:00:00.000Z',
    })
    expect(() => assertFirstRunConfigCompatible({ ...config, schema_version: 2 }))
      .toThrow('unsupported first-run configuration schema')
    expect(() => assertFirstRunConfigCompatible({ ...config, unknown: true }))
      .toThrow('unknown or missing fields')
    expect(() => assertFirstRunConfigCompatible({
      ...config,
      safe_defaults: { ...config.safe_defaults, bind_host: '0.0.0.0' },
    })).toThrow('safe default drift: bind_host')
    expect(() => assertFirstRunConfigCompatible({
      ...config,
      api_token: 'not-allowed',
    })).toThrow('forbidden sensitive field')
  })
})
