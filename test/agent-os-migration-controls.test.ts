import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

type Binding = {
  kind: 'environment' | 'release_gate' | 'reserved'
  name: string
  enabled_value?: string
  source?: string
  source_marker?: string
  test?: string
}

type Control = {
  id: string
  implementation_state: 'wired' | 'release_gate' | 'reserved'
  lifecycle: 'reserved' | 'wired_off'
  default_enabled: boolean
  binding: Binding
}

type Rollback = {
  checkpoint: string
  triggers: string[]
  actions: string[]
  verification: string[]
  data_policy: string
}

type Phase = {
  phase: number
  id: string
  name: string
  flags: Control[]
  activation_gate: string
  telemetry: string[]
  rollback: Rollback
}

type MigrationControls = {
  schema_version: number
  backlog_item: string
  status: string
  scope: string
  control_lifecycle: string[]
  implementation_states: string[]
  global_activation_order: string[]
  global_rollback_invariants: string[]
  excluded_operational_controls: Array<{ name: string; reason: string }>
  phases: Phase[]
}

const root = join(import.meta.dirname, '..')
const read = (path: string): string => readFileSync(join(root, path), 'utf8')
const controls = JSON.parse(
  read('docs/agent-os-migration-controls.json'),
) as MigrationControls
const markdown = read('docs/agent-os-migration-controls.md')

const nonempty = (values: readonly string[]): boolean =>
  values.length > 0 && values.every((value) => value.trim().length > 0)

describe('Agent OS migration control contract', () => {
  it('defines one complete rollback boundary for every phase', () => {
    expect(controls).toMatchObject({
      schema_version: 1,
      backlog_item: 'BASE-007',
      status: 'defined',
      scope: 'Agent OS phases 0 through 18',
    })
    expect(controls.phases.map((phase) => phase.phase))
      .toEqual(Array.from({ length: 19 }, (_, phase) => phase))
    expect(controls.phases.map((phase) => phase.id))
      .toEqual(Array.from(
        { length: 19 },
        (_, phase) => `phase-${String(phase).padStart(2, '0')}`,
      ))
    expect(new Set(controls.phases.map((phase) => phase.name)).size).toBe(19)

    for (const phase of controls.phases) {
      expect(phase.flags.length, `${phase.id} has no migration control`).toBeGreaterThan(0)
      expect(phase.activation_gate.trim(), `${phase.id} has no activation gate`).not.toBe('')
      expect(nonempty(phase.telemetry), `${phase.id} has no telemetry contract`).toBe(true)
      expect(phase.rollback.checkpoint.trim(), `${phase.id} has no checkpoint`).not.toBe('')
      expect(nonempty(phase.rollback.triggers), `${phase.id} has no rollback trigger`).toBe(true)
      expect(nonempty(phase.rollback.actions), `${phase.id} has no rollback action`).toBe(true)
      expect(
        nonempty(phase.rollback.verification),
        `${phase.id} has no rollback verification`,
      ).toBe(true)
      expect(phase.rollback.data_policy.trim(), `${phase.id} has no data policy`).not.toBe('')
    }
  })

  it('keeps every control closed, unique, and honest about implementation', () => {
    expect(controls.control_lifecycle).toEqual([
      'reserved',
      'wired_off',
      'canary',
      'default_on',
      'retire_pending',
      'retired',
    ])
    expect(controls.implementation_states).toEqual([
      'wired',
      'release_gate',
      'reserved',
    ])

    const flags = controls.phases.flatMap((phase) => phase.flags)
    expect(flags).toHaveLength(44)
    expect(new Set(flags.map((flag) => flag.id)).size).toBe(flags.length)
    expect(flags.every((flag) => flag.default_enabled === false)).toBe(true)

    for (const flag of flags) {
      if (flag.implementation_state === 'wired') {
        expect(flag.lifecycle).toBe('wired_off')
        expect(flag.binding.kind).toBe('environment')
        expect(flag.binding.name).toMatch(/^ORCHESTRA_[A-Z0-9_]+$/)
        expect(flag.binding.enabled_value).toBe('1')
        expect(flag.binding.source).toBeTruthy()
        expect(flag.binding.source_marker).toBeTruthy()
        expect(flag.binding.test).toBeTruthy()
        expect(read(flag.binding.source as string)).toContain(
          flag.binding.source_marker as string,
        )
        expect(read(flag.binding.test as string)).toContain(flag.binding.name)
      } else if (flag.implementation_state === 'reserved') {
        expect(flag.lifecycle).toBe('reserved')
        expect(flag.binding.kind).toBe('reserved')
        expect(flag.binding.name).toMatch(/^agent_os\./)
      } else {
        expect(flag.lifecycle).toBe('wired_off')
        expect(flag.binding.kind).toBe('release_gate')
        expect(flag.binding.name).toMatch(/^[A-Z][A-Z0-9-]+$/)
      }
    }
  })

  it('binds only the two real phase flags to current source', () => {
    const wired = controls.phases
      .flatMap((phase) => phase.flags.map((flag) => ({ phase: phase.phase, flag })))
      .filter(({ flag }) => flag.implementation_state === 'wired')
      .map(({ phase, flag }) => ({
        phase,
        id: flag.id,
        binding: flag.binding.name,
      }))

    expect(wired).toEqual([
      {
        phase: 2,
        id: 'orchestration.canonical_launch',
        binding: 'ORCHESTRA_CANONICAL_LAUNCH',
      },
      {
        phase: 10,
        id: 'providers.codex.contract_route',
        binding: 'ORCHESTRA_CODEX_PROVIDER_CONTRACT',
      },
    ])
    expect(markdown).toContain('**2 wired runtime flags, 6 release gates, and 36 reserved')
    expect(markdown).toContain('A flag alone cannot bypass manifest, executable')
    expect(markdown).toContain('does not claim that reserved controls')
  })

  it('keeps remote rollout independently killable without reviving master-token pairing', () => {
    const remote = controls.phases.find((phase) => phase.phase === 13)
    expect(remote?.flags.map((flag) => flag.id)).toEqual([
      'remote.pairing',
      'remote.device_auth',
      'remote.scoped_mutation',
      'remote.public_tunnel',
      'remote.terminal_write',
      'remote.push',
      'remote.kill_switch',
    ])
    expect(remote?.flags.every((flag) =>
      flag.implementation_state === 'reserved'
      && flag.default_enabled === false)).toBe(true)
    expect(remote?.rollback.actions).toContain(
      'Activate remote.kill_switch and stop accepting remote requests',
    )
    expect(remote?.rollback.verification.join(' ')).toContain(
      'does not restore a reusable master-token QR',
    )
    expect(markdown).toContain('The local loopback operator recovery path remains')
  })

  it('separates forward-only data recovery from feature rollback', () => {
    expect(nonempty(controls.global_activation_order)).toBe(true)
    expect(nonempty(controls.global_rollback_invariants)).toBe(true)
    const invariants = controls.global_rollback_invariants.join(' ')
    expect(invariants).toContain('forward-only')
    expect(invariants).toContain('never runs an automatic down migration')
    expect(invariants).toContain('never silently substitutes a provider or billing mode')
    expect(invariants).toContain('never revives expired sessions')
    expect(markdown).toContain('Feature rollback and data recovery are different operations')
    expect(markdown).toContain('A phase with no safe compatibility path fails closed')
  })

  it('excludes behavior and development toggles from migration authority', () => {
    const excluded = controls.excluded_operational_controls.map(({ name }) => name)
    expect(excluded).toEqual([
      'ORCHESTRA_NO_AUTH',
      'ORCHESTRA_AUTOWAKE',
      'ORCHESTRA_AUTOSHIP',
      'ORCHESTRA_VERBOSE_RULES',
      'ORCHESTRA_VERBOSE_OUTPUT',
    ])
    const bindings = new Set(
      controls.phases.flatMap((phase) =>
        phase.flags.map((flag) => flag.binding.name)),
    )
    expect(excluded.every((name) => !bindings.has(name))).toBe(true)
    expect(markdown).toContain('cannot serve as authority')
  })

  it('ships and links both migration-control artifacts', () => {
    const packageManifest = JSON.parse(read('package.json')) as { files?: string[] }
    expect(packageManifest.files).toEqual(expect.arrayContaining([
      'docs/agent-os-migration-controls.json',
      'docs/agent-os-migration-controls.md',
    ]))
    expect(read('docs/agent-os-domain.md'))
      .toContain('[migration-control matrix](./agent-os-migration-controls.md)')
    expect(read('docs/agent-os.md'))
      .toContain('[migration controls and rollback contract](./agent-os-migration-controls.md)')
    expect(read('README.md'))
      .toContain('[migration-control and rollback matrix](docs/agent-os-migration-controls.md)')
  })
})
