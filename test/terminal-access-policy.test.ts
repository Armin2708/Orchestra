import { describe, expect, it } from 'vitest'
import { evaluateTerminalAccess } from '../src/agent-os/terminal-access-policy.js'

const resource = { workspaceId: 'workspace-1', processId: 'process-1' }
const now = '2026-08-02T12:00:00.000Z'

describe('terminal access policy', () => {
  it('keeps authenticated views available while failing closed for mutations', () => {
    expect(evaluateTerminalAccess('view', resource, {
      authenticated: true,
      principal: 'remote_device',
      surface: 'mobile',
      scopes: [],
      now,
    })).toEqual({ allowed: true, reason_code: 'authenticated_view' })
    expect(evaluateTerminalAccess('input', resource, {
      authenticated: true,
      principal: 'remote_device',
      surface: 'desktop',
      scopes: [],
      now,
    })).toEqual({ allowed: false, reason_code: 'remote_view_only_default' })
    expect(evaluateTerminalAccess('resize', resource, {
      authenticated: true,
      principal: 'local_operator',
      surface: 'mobile',
      scopes: [],
      now,
    })).toEqual({ allowed: false, reason_code: 'mobile_view_only_default' })
  })

  it('preserves normal local operator terminal parity', () => {
    for (const action of ['select', 'spawn', 'input', 'resize', 'signal', 'restart', 'history_write'] as const) {
      expect(evaluateTerminalAccess(action, resource, {
        authenticated: true,
        principal: 'local_operator',
        surface: 'desktop',
        scopes: [],
        now,
      })).toEqual({ allowed: true, reason_code: 'local_operator' })
    }
    expect(evaluateTerminalAccess('input', resource, {
      authenticated: true,
      principal: 'local_operator',
      surface: 'unknown',
      scopes: [],
      now,
    })).toEqual({ allowed: false, reason_code: 'terminal_mutation_denied' })
  })

  it('requires an exact resource-bound, device-bound, recent remote grant', () => {
    const grant = {
      grantId: 'grant-1',
      deviceId: 'device-1',
      workspaceId: resource.workspaceId,
      processId: resource.processId,
      actions: ['input', 'resize'] as const,
      issuedAt: '2026-08-02T11:59:00.000Z',
      expiresAt: '2026-08-02T12:01:00.000Z',
      stepUpVerifiedAt: '2026-08-02T11:59:30.000Z',
    }
    expect(evaluateTerminalAccess('input', resource, {
      authenticated: true,
      principal: 'remote_device',
      surface: 'mobile',
      scopes: ['terminal-write'],
      deviceId: 'device-1',
      grant,
      now,
    })).toEqual({ allowed: true, reason_code: 'explicit_terminal_write_grant' })
    expect(evaluateTerminalAccess('signal', resource, {
      authenticated: true,
      principal: 'remote_device',
      surface: 'mobile',
      scopes: ['terminal-write'],
      deviceId: 'device-1',
      grant,
      now,
    })).toEqual({ allowed: false, reason_code: 'terminal_write_grant_invalid' })
    expect(evaluateTerminalAccess('input', resource, {
      authenticated: true,
      principal: 'remote_device',
      surface: 'mobile',
      scopes: ['terminal-write'],
      deviceId: 'other-device',
      grant,
      now,
    })).toEqual({ allowed: false, reason_code: 'terminal_write_grant_invalid' })
    expect(evaluateTerminalAccess('input', resource, {
      authenticated: true,
      principal: 'remote_device',
      surface: 'mobile',
      scopes: ['terminal-write'],
      deviceId: 'device-1',
      grant: { ...grant, expiresAt: 'not-a-date' },
      now,
    })).toEqual({ allowed: false, reason_code: 'terminal_write_grant_invalid' })
  })
})
