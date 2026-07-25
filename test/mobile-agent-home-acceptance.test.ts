import { describe, expect, it } from 'vitest'
import type { AgentHomeCapabilities, AgentSessionRecord } from '../web/src/agentHomeApi.js'
import {
  agentHomeActionPresentation,
  agentHomeSessionPresentation,
} from '../web/src/agentHomePresentation.js'
import {
  boardIdFromSearch,
  cardDrawerDeepLink,
  cardIdFromSearch,
} from '../web/src/boardDeepLink.js'

const session = (overrides: Partial<AgentSessionRecord> = {}): AgentSessionRecord => ({
  id: 'session-1',
  workspace_id: 'workspace-1',
  agent_id: null,
  provider: 'codex',
  external_id: null,
  model: 'gpt-5',
  status: 'running',
  control_state: 'active',
  context: {},
  profile_id: 'profile-1',
  conversation_id: 'conversation-1',
  job_id: 'job-1',
  mode: 'managed',
  driver_id: 'codex',
  effort: 'high',
  access_profile: 'workspace_write',
  provider_thread_id: null,
  provider_cursor: null,
  recovery_state: 'recoverable',
  recovery: {},
  history_state: 'complete',
  started_at: '2026-07-25T10:00:00Z',
  ended_at: null,
  archived_at: null,
  created_at: '2026-07-25T10:00:00Z',
  updated_at: '2026-07-25T10:00:00Z',
  ...overrides,
})

const capabilities: AgentHomeCapabilities = {
  provider: 'codex',
  actions: {
    resume: { supported: true, allowed: true, requires_operator: true, reason: null },
    pause: { supported: false, allowed: false, requires_operator: true, reason: 'Pause requires an active session.' },
    stop: { supported: true, allowed: true, requires_operator: true, reason: null },
    retry: { supported: false, allowed: false, requires_operator: true, reason: 'Retry requires a stopped session.' },
    fork: { supported: false, allowed: false, requires_operator: true, reason: 'Fork is unavailable.' },
    rename: { supported: true, allowed: true, requires_operator: true, reason: null },
    archive: { supported: false, allowed: false, requires_operator: true, reason: 'Archive requires a stopped session.' },
  },
}

describe('mobile Agent Home acceptance contracts', () => {
  it('presents a paused idle session as paused with Resume and Stop controls', () => {
    const presentation = agentHomeSessionPresentation(session({
      status: 'idle',
      control_state: 'paused',
    }))

    expect(presentation.status).toBe('paused')
    expect(presentation.quickActions).toEqual(['resume', 'stop'])
  })

  it('keeps every lifecycle control reachable from the phone action menu', () => {
    expect(agentHomeSessionPresentation(session()).mobileActions)
      .toEqual(['resume', 'pause', 'stop', 'retry'])
  })

  it('preserves lifecycle truth for stopped and archived control states', () => {
    expect(agentHomeSessionPresentation(session({
      status: 'failed',
      control_state: 'stopped',
    }))).toMatchObject({
      status: 'failed',
      quickActions: ['retry'],
    })
    expect(agentHomeSessionPresentation(session({
      status: 'idle',
      control_state: 'stopped',
    }))).toMatchObject({
      status: 'stopped',
      quickActions: ['retry'],
    })
    expect(agentHomeSessionPresentation(session({
      status: 'stopped',
      control_state: 'archived',
    }))).toMatchObject({
      status: 'archived',
      quickActions: [],
    })
  })

  it('uses capability truth to enable or disable phone lifecycle entries', () => {
    expect(agentHomeActionPresentation(capabilities, 'resume', {
      hasSession: true,
      busyAction: null,
    })).toEqual({ disabled: false, reason: undefined })
    expect(agentHomeActionPresentation(capabilities, 'pause', {
      hasSession: true,
      busyAction: null,
    })).toEqual({ disabled: true, reason: 'Pause requires an active session.' })
    expect(agentHomeActionPresentation(capabilities, 'stop', {
      hasSession: true,
      busyAction: 'resume',
    })).toEqual({ disabled: true, reason: undefined })
    expect(agentHomeActionPresentation(capabilities, 'resume', {
      hasSession: false,
      busyAction: null,
    })).toEqual({ disabled: true, reason: 'No provider session is selected.' })
  })

  it('round-trips a card drawer deep link across refresh and clears only the card on close', () => {
    const openUrl = cardDrawerDeepLink('?board=1&card=1&debug=1', {
      boardId: 1,
      cardId: 1,
    }, { pathname: '/', hash: '#drawer' })

    expect(openUrl).toBe('/?board=1&card=1&debug=1#drawer')
    expect(boardIdFromSearch(new URL(openUrl, 'http://orchestra.local').search)).toBe(1)
    expect(cardIdFromSearch(new URL(openUrl, 'http://orchestra.local').search)).toBe(1)
    expect(cardDrawerDeepLink(new URL(openUrl, 'http://orchestra.local').search, {
      boardId: 1,
      cardId: null,
    }, { pathname: '/', hash: '#drawer' })).toBe('/?board=1&debug=1#drawer')
    expect(cardIdFromSearch('?card=0')).toBeNull()
    expect(cardIdFromSearch('?card=not-a-number')).toBeNull()
    expect(boardIdFromSearch('?board=2&card=1')).toBe(2)
  })
})
