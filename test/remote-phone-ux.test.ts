import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { normalizeManagedDevices } from '../web/src/RemoteAccessCenter.js'
import {
  hasRemoteScope,
  matchesDeviceRevokeGrant,
  normalizeRemoteDeviceSession,
  remoteCanUse,
  safeNotificationPath,
} from '../web/src/remotePolicy.js'

const root = path.resolve(import.meta.dirname, '..')
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8')

describe('remote phone policy', () => {
  it('normalizes only public DeviceSession fields and closed scopes', () => {
    expect(normalizeRemoteDeviceSession({
      device_session_id: 'phone-1',
      name: 'Armin phone',
      scopes: ['observe', 'message', 'terminal-write', 'unknown'],
      expires_at: '2026-08-03T12:00:00Z',
      credential_expires_at: '2026-08-02T13:00:00Z',
      credential_hash: 'must-not-be-used',
      step_up: {
        id: 'grant-1',
        active_until: '2026-08-02T12:05:00Z',
        action: 'terminal-write',
        resource_type: 'process',
        resource_id: 'process-7',
        request_digest: `sha256:${'a'.repeat(64)}`,
        nonce: 'nonce-1',
      },
    })).toEqual({
      device_session_id: 'phone-1',
      name: 'Armin phone',
      scopes: ['observe', 'message', 'terminal-write'],
      expires_at: '2026-08-03T12:00:00Z',
      credential_expires_at: '2026-08-02T13:00:00Z',
      step_up: {
        id: 'grant-1',
        active_until: '2026-08-02T12:05:00Z',
        action: 'terminal-write',
        resource_type: 'process',
        resource_id: 'process-7',
        request_digest: `sha256:${'a'.repeat(64)}`,
        nonce: 'nonce-1',
      },
    })
  })

  it('keeps terminal control view-only without scope, online state, and an exact active grant', () => {
    const session = normalizeRemoteDeviceSession({
      device_session_id: 'phone-1',
      name: 'Phone',
      scopes: ['observe', 'terminal-write'],
      expires_at: '2026-08-03T12:00:00Z',
      credential_expires_at: '2026-08-02T13:00:00Z',
      step_up: {
        id: 'grant-terminal',
        active_until: '2026-08-02T12:05:00Z',
        action: 'terminal-write',
        resource_type: 'process',
        resource_id: 'process-7',
        request_digest: `sha256:${'c'.repeat(64)}`,
        nonce: 'nonce-terminal',
      },
    })
    expect(session).not.toBeNull()
    expect(remoteCanUse(session, true, 'terminal-write', 'process', 'process-7', Date.parse('2026-08-02T12:00:00Z'))).toBe(true)
    expect(remoteCanUse(session, false, 'terminal-write', 'process', 'process-7', Date.parse('2026-08-02T12:00:00Z'))).toBe(false)
    expect(remoteCanUse(session, true, 'terminal-write', 'process', 'process-8', Date.parse('2026-08-02T12:00:00Z'))).toBe(false)
    expect(remoteCanUse(session, true, 'terminal-write', 'process', 'process-7', Date.parse('2026-08-02T12:06:00Z'))).toBe(false)
  })

  it('fails every remote scope and step-up closed when either expiry is stale or invalid', () => {
    const createSession = (expiresAt: string, credentialExpiresAt: string) => normalizeRemoteDeviceSession({
      device_session_id: 'phone-1',
      name: 'Phone',
      scopes: ['message', 'approve', 'admin'],
      expires_at: expiresAt,
      credential_expires_at: credentialExpiresAt,
      step_up: {
        id: 'grant-revoke',
        active_until: '2026-08-02T12:05:00Z',
        action: 'device.revoke',
        resource_type: 'device',
        resource_id: 'phone-2',
        request_digest: `sha256:${'b'.repeat(64)}`,
        nonce: 'nonce-revoke',
      },
    })
    const now = Date.parse('2026-08-02T12:00:00Z')
    const active = createSession('2026-08-03T12:00:00Z', '2026-08-02T13:00:00Z')
    expect(hasRemoteScope(active, 'message', now)).toBe(true)
    expect(remoteCanUse(active, true, 'admin', 'device', 'phone-2', now)).toBe(true)
    expect(matchesDeviceRevokeGrant(active, 'phone-2', `sha256:${'b'.repeat(64)}`, 'nonce-revoke', now)).toBe(true)

    for (const expired of [
      createSession('2026-08-02T12:00:00Z', '2026-08-02T13:00:00Z'),
      createSession('2026-08-03T12:00:00Z', '2026-08-02T12:00:00Z'),
      createSession('invalid', '2026-08-02T13:00:00Z'),
      createSession('2026-08-03T12:00:00Z', ''),
    ]) {
      expect(hasRemoteScope(expired, 'message', now)).toBe(false)
      expect(remoteCanUse(expired, true, 'message', undefined, undefined, now)).toBe(false)
      expect(remoteCanUse(expired, true, 'admin', 'device', 'phone-2', now)).toBe(false)
    }
  })

  it('allows only normalized same-origin notification destinations', () => {
    const origin = 'https://orchestra.example.test'
    expect(safeNotificationPath('/?board=7&approval=req-2', origin)).toBe('/?board=7&approval=req-2')
    expect(safeNotificationPath('https://evil.test/?approval=req-2', origin)).toBe('/')
    expect(safeNotificationPath('//evil.test/path', origin)).toBe('/')
    expect(safeNotificationPath('/admin?board=7', origin)).toBe('/')
    expect(safeNotificationPath('/?redirect=https://evil.test&board=7', origin)).toBe('/?board=7')
    expect(safeNotificationPath('/?board=%0d%0aInjected', origin)).toBe('/')
  })

  it('presents named device inventory without secret-bearing fields', () => {
    expect(normalizeManagedDevices({ devices: [{
      id: 'device-a', name: 'Phone A', scopes: ['observe', 'approve'], state: 'active',
      last_seen_at: '2026-08-02T10:00:00Z', expires_at: '2026-08-09T10:00:00Z',
      credential_expires_at: '2026-08-02T11:00:00Z', credential: 'hidden', current: true,
    }] }, 'device-a')).toEqual([{
      id: 'device-a', name: 'Phone A', scopes: ['observe', 'approve'], state: 'active',
      last_seen_at: '2026-08-02T10:00:00Z', expires_at: '2026-08-09T10:00:00Z',
      credential_expires_at: '2026-08-02T11:00:00Z', current: true,
    }])
  })
})

describe('remote phone acceptance surface', () => {
  it('makes offline state explicit and never adds a mutation replay mechanism', () => {
    const access = read('web/src/RemoteAccess.tsx')
    const worker = read('web/public/sw.js')
    expect(access).toContain('Offline · read-only')
    expect(access).toContain('will not be queued')
    expect(worker).toContain("e.request.method !== 'GET'")
    expect(worker).toContain('Background Sync, outbox, retry, or replay path')
    expect(worker).not.toContain("addEventListener('sync'")
    expect(worker).not.toContain('API_CACHE')
  })

  it('ships generic push previews and a same-origin click allowlist', () => {
    const worker = read('web/public/sw-push.js')
    expect(worker).toContain('Orchestra needs your attention')
    expect(worker).toContain("d.preview === 'content'")
    expect(worker).toContain('parsed.origin !== self.location.origin')
    expect(worker).toContain('safeNotificationPath(e.notification.data?.url)')
  })

  it('exposes phone monitoring, messaging, approval, pause, and stop navigation', () => {
    const dock = read('web/src/PhoneRemoteDock.tsx')
    for (const label of ['Monitor', 'Message', 'Approve', 'Pause / stop']) expect(dock).toContain(label)
    expect(read('web/src/AgentHomePanels.tsx')).toContain("canUse('terminal-write'")
    expect(read('web/src/AgentTerminal.tsx')).toContain("canUse('agent-control'")
    expect(read('web/src/ProcessTerminal.tsx')).toContain("canUse('terminal-write'")
  })

  it('documents iOS and Android install/reconnect plus quiet-hours and severity controls', () => {
    const center = read('web/src/RemoteAccessCenter.tsx')
    for (const marker of ['iPhone / iPad', 'Android', 'Quiet hours start', 'Minimum severity', 'Generic (recommended)']) {
      expect(center).toContain(marker)
    }
    for (const field of ['Last seen', 'Session expiry', 'Credential expiry', 'Revoke only this device']) {
      expect(center).toContain(field)
    }
  })

  it('binds destructive device revocation to an exact active admin step-up', () => {
    const access = read('web/src/RemoteAccess.tsx')
    const center = read('web/src/RemoteAccessCenter.tsx')
    expect(access).toContain('session.credential_expires_at')
    expect(access).toContain('session.step_up?.active_until')
    expect(access).toContain('setAuthorizationEpoch')
    expect(center).toContain("access.canUse('admin', 'device', device.id)")
    expect(center).toContain("access.requestStepUp('admin', 'device', device.id")
    expect(center).toContain("operation: 'device.revoke', requestDigest, nonce")
    expect(center).toContain('matchesDeviceRevokeGrant(')
    expect(center).toContain("'x-orchestra-step-up-grant': grant.id")
    expect(center).toContain("'x-orchestra-step-up-nonce': grant.nonce")
  })
})
