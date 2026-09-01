import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  applyFirstRunAmbientHooks,
  applyFirstRunPlan,
  assertFirstRunConfigCompatible,
  buildFirstRunPlan,
  firstRunConfigPath,
  runFirstRunConfigTransaction,
  writeFirstRunConfig,
  type FirstRunConfigV1,
  type FirstRunPlan,
} from '../src/first-run-onboarding.js'

describe('first-run onboarding domain', () => {
  const configFor = (root: string): FirstRunConfigV1 => ({
    schema_version: 1,
    project_root: root,
    provider_id: 'codex',
    execution_mode: 'native_subscription',
    hook_scope: 'off',
    telemetry: 'redacted',
    safe_defaults: {
      bind_host: '127.0.0.1',
      remote_access: 'off',
      terminal_remote_write: 'off',
      telemetry: 'redacted',
      usage_priced_api_fallback: 'off',
      destructive_cleanup: 'manual_only',
      workspace_mode: 'isolated_worktree',
    },
    configured_at: '2026-08-02T12:00:00.000Z',
  })

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

  it('rederives the exact candidate plan and rejects it before any write', () => {
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
  })

  it('installs ambient Claude hooks while keeping managed launch policy-blocked', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-onboarding-ambient-'))
    const installProviderHooks = vi.fn()
    const plan = buildFirstRunPlan({
      project_root: root,
      provider_id: 'claude',
      execution_mode: 'native_subscription',
      hook_scope: 'project',
      telemetry: 'off',
    })

    const result = applyFirstRunAmbientHooks(plan, { installProviderHooks })

    expect(result).toMatchObject({
      schema_version: 1,
      provider_id: 'claude',
      scope: 'project',
      managed_launch_ready: false,
    })
    expect(result.managed_launch_blockers.map((blocker) => blocker.code))
      .toEqual(expect.arrayContaining([
        'provider_not_release_supported',
        'provider_acceptance_not_ready',
        'provider_mode_not_supported',
      ]))
    expect(installProviderHooks).toHaveBeenCalledWith('project', {
      provider: 'claude',
      roots: { cwd: root },
    })
  })

  it('keeps ambient hook installation explicit, exact, and provider-scoped', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-onboarding-ambient-guard-'))
    const installProviderHooks = vi.fn()
    const off = buildFirstRunPlan({
      project_root: root,
      provider_id: 'claude',
      hook_scope: 'off',
    })
    expect(() => applyFirstRunAmbientHooks(off, { installProviderHooks }))
      .toThrow('requires project or global scope')

    const qwen = buildFirstRunPlan({
      project_root: root,
      provider_id: 'qwen',
      hook_scope: 'project',
    })
    expect(() => applyFirstRunAmbientHooks(qwen, { installProviderHooks }))
      .toThrow('available only for Claude Code and Codex CLI')

    const opencode = buildFirstRunPlan({
      project_root: root,
      provider_id: 'opencode',
      hook_scope: 'project',
    })
    expect(() => applyFirstRunAmbientHooks(opencode, { installProviderHooks }))
      .toThrow('available only for Claude Code and Codex CLI')

    const providerApi = buildFirstRunPlan({
      project_root: root,
      provider_id: 'claude',
      execution_mode: 'provider_api',
      hook_scope: 'project',
    })
    expect(() => applyFirstRunAmbientHooks(providerApi, { installProviderHooks }))
      .toThrow('require native-subscription terminal mode')

    const claude = buildFirstRunPlan({
      project_root: root,
      provider_id: 'claude',
      hook_scope: 'project',
    })
    const forged = {
      ...claude,
      provider: { ...claude.provider, release_state: 'validated' },
    } as FirstRunPlan
    expect(() => applyFirstRunAmbientHooks(forged, { installProviderHooks }))
      .toThrow('stale or forged')
    expect(installProviderHooks).not.toHaveBeenCalled()
  })

  it('rejects forged cleared blockers for Codex, Qwen, and OpenCode before any write', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-onboarding-forged-'))
    const configPath = path.join(root, 'state', 'onboarding.json')
    const installProviderHooks = vi.fn()
    for (const provider_id of ['codex', 'qwen', 'opencode'] as const) {
      const candidate = buildFirstRunPlan({
        project_root: root,
        provider_id,
        hook_scope: provider_id === 'codex' ? 'project' : 'off',
      })
      const forged: FirstRunPlan = {
        ...candidate,
        provider: {
          ...candidate.provider,
          release_state: 'validated',
          support_state: 'supported',
          support_reason: null,
        },
        hooks: { ...candidate.hooks, capability_state: 'supported' },
        blockers: [],
        ready_for_managed_launch: true,
      }
      expect(() => applyFirstRunPlan(forged, { configPath, installProviderHooks }))
        .toThrow('stale or forged relative to the current provider manifest')
    }
    expect(installProviderHooks).not.toHaveBeenCalled()
    expect(fs.existsSync(configPath)).toBe(false)
  })

  it('rejects forged runtime, billing, defaults, and advanced controls', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-onboarding-mutation-'))
    const configPath = path.join(root, 'onboarding.json')
    const candidate = buildFirstRunPlan({ project_root: root, provider_id: 'codex' })
    const mutations: FirstRunPlan[] = [
      {
        ...candidate,
        provider: { ...candidate.provider, runtime_mode: 'provider_api' },
      },
      {
        ...candidate,
        provider: { ...candidate.provider, billing_mode: 'usage_priced_api' },
      },
      {
        ...candidate,
        defaults: {
          ...candidate.defaults,
          bind_host: '0.0.0.0',
        },
      } as unknown as FirstRunPlan,
      {
        ...candidate,
        advanced_controls: [...candidate.advanced_controls, {
          id: 'untrusted', state: 'available', detail: 'forged control',
        }],
      },
    ]

    for (const mutated of mutations) {
      expect(() => applyFirstRunPlan(mutated, { configPath }))
        .toThrow('stale or forged relative to the current provider manifest')
    }
    expect(fs.existsSync(configPath)).toBe(false)
  })

  it('rejects unsafe plan identifiers before touching files or hooks', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-onboarding-identifiers-'))
    const configPath = path.join(root, 'onboarding.json')
    const installProviderHooks = vi.fn()
    const candidate = buildFirstRunPlan({ project_root: root, provider_id: 'codex' })
    const invalid = {
      ...candidate,
      provider: { ...candidate.provider, id: '../codex' },
    } as unknown as FirstRunPlan

    expect(() => applyFirstRunPlan(invalid, { configPath, installProviderHooks }))
      .toThrow('identifiers are invalid; no files were changed')
    expect(installProviderHooks).not.toHaveBeenCalled()
    expect(fs.existsSync(configPath)).toBe(false)
  })

  it('restores the previous config exactly when hook installation fails', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-onboarding-rollback-'))
    const configPath = path.join(root, 'state', 'onboarding.json')
    const previous = configFor(root)
    writeFirstRunConfig(configPath, previous)
    const previousBytes = fs.readFileSync(configPath, 'utf8')
    const previousMode = fs.statSync(configPath).mode & 0o777

    const replacement = {
      ...previous,
      telemetry: 'off' as const,
      safe_defaults: {
        ...previous.safe_defaults,
        telemetry: 'off' as const,
      },
      configured_at: '2026-08-03T08:00:00.000Z',
    }

    expect(() => runFirstRunConfigTransaction(
      configPath,
      replacement,
      () => { throw new Error('simulated hook failure') },
    )).toThrow('simulated hook failure')

    expect(fs.readFileSync(configPath, 'utf8')).toBe(previousBytes)
    expect(fs.statSync(configPath).mode & 0o777).toBe(previousMode)
  })

  it('removes a newly created config when the surrounding setup fails', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-onboarding-new-rollback-'))
    const configPath = path.join(root, 'state', 'onboarding.json')

    expect(() => runFirstRunConfigTransaction(
      configPath,
      configFor(root),
      () => { throw new Error('simulated downstream failure') },
    )).toThrow('simulated downstream failure')
    expect(fs.existsSync(configPath)).toBe(false)
  })

  it('writes a strict owner-only compatible config without secrets', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-onboarding-config-'))
    const configPath = path.join(root, 'state', 'onboarding.json')
    const config = configFor(root)

    writeFirstRunConfig(configPath, config)

    expect(assertFirstRunConfigCompatible(
      JSON.parse(fs.readFileSync(configPath, 'utf8')),
    )).toEqual(config)
    expect(fs.statSync(configPath).mode & 0o777).toBe(0o600)
    expect(fs.readFileSync(configPath, 'utf8')).not.toMatch(/api[_-]?key|token|secret/i)
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
    const config = configFor(root)
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

  it('requires an absolute non-empty ORCHESTRA_HOME', () => {
    expect(() => firstRunConfigPath({ ORCHESTRA_HOME: 'relative/state' }))
      .toThrow('ORCHESTRA_HOME must be a non-empty absolute path')
    expect(() => firstRunConfigPath({ ORCHESTRA_HOME: '' }))
      .toThrow('ORCHESTRA_HOME must be a non-empty absolute path')
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-onboarding-path-'))
    expect(firstRunConfigPath({ ORCHESTRA_HOME: root }))
      .toBe(path.join(root, 'onboarding.json'))
  })
})
