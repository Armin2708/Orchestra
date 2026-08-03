import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { AgentHomeHeader, AgentTerminalPanel } from '../web/src/AgentHomePanels.js'
import { ContextPane, ProcessesPane } from '../web/src/WorkspacePanes.js'
import { routeTerminalKeyEvent } from '../web/src/ProcessTerminal.js'
import { runRuntimeMutation } from '../web/src/runtimeReadOnly.js'

const requireFromWeb = createRequire(new URL('../web/package.json', import.meta.url))
const { createElement } = requireFromWeb('react') as {
  createElement: (component: unknown, props: Record<string, unknown>, ...children: unknown[]) => unknown
}
const { renderToStaticMarkup } = requireFromWeb('react-dom/server') as {
  renderToStaticMarkup: (node: unknown) => string
}

const appSource = readFileSync(new URL('../web/src/App.tsx', import.meta.url), 'utf8')
const agentHomeSource = readFileSync(new URL('../web/src/AgentHome.tsx', import.meta.url), 'utf8')
const cockpitSource = readFileSync(new URL('../web/src/WorkspaceCockpit.tsx', import.meta.url), 'utf8')
const terminalSource = readFileSync(new URL('../web/src/ProcessTerminal.tsx', import.meta.url), 'utf8')

describe('offline canonical runtime composition', () => {
  it('does not invoke a guarded runtime mutation while read only', async () => {
    const mutation = vi.fn(async () => 'changed')
    await expect(runRuntimeMutation(true, mutation)).resolves.toEqual({ performed: false })
    expect(mutation).not.toHaveBeenCalled()
    await expect(runRuntimeMutation(false, mutation)).resolves.toEqual({
      performed: true,
      value: 'changed',
    })
    expect(mutation).toHaveBeenCalledOnce()
  })

  it('disables Agent Home lifecycle and PTY mutations while keeping runtime facts readable', () => {
    const profile = {
      id: 'profile-1', board_id: 7, legacy_agent_id: null, name: 'Release agent', role: 'Verifier',
      default_provider: 'codex', default_model: 'gpt-5', default_effort: null,
      default_access_profile: 'workspace_write', capabilities: [], owner_actor_type: 'operator',
      owner_actor_id: 'test', status: 'active', provenance: {}, created_at: '', updated_at: '', archived_at: null,
    }
    const session = {
      id: 'session-1', workspace_id: 'workspace-1', agent_id: null, provider: 'codex', external_id: null,
      model: 'gpt-5', status: 'running', control_state: 'active', context: {}, profile_id: 'profile-1',
      conversation_id: null, job_id: null, job_assignment_id: null, assigned_profile_id: null,
      assignment_market_version: null, mode: 'managed', driver_id: 'codex', effort: null,
      access_profile: 'workspace_write', provider_thread_id: null, provider_cursor: null,
      recovery_state: 'recoverable', recovery: {}, history_state: 'complete', started_at: null,
      ended_at: null, archived_at: null, created_at: '', updated_at: '',
    }
    const capabilities = {
      provider: 'codex',
      actions: Object.fromEntries(['resume', 'pause', 'stop', 'retry', 'fork', 'rename', 'archive']
        .map((action) => [action, { supported: true, allowed: true, requires_operator: true, reason: null }])),
    }
    const header = renderToStaticMarkup(createElement(AgentHomeHeader, {
      profile, session, conversation: null, workspace: null, job: null, contract: null, process: null,
      attention: [], capabilities, busyAction: null, error: null, copied: false, readOnly: true,
      onAction: () => undefined, onRefresh: () => undefined, onCopyLink: () => undefined,
    }))
    expect(header).toContain('Release agent')
    expect(header).toContain('session-1')
    expect(header).toMatch(/<button[^>]*disabled=""[^>]*>(?:pause|stop|fork|rename|archive)/)

    const terminal = renderToStaticMarkup(createElement(AgentTerminalPanel, {
      workspace: { id: 'workspace-1', name: 'Retained workspace', root_path: '/repo' },
      processes: [{ id: 'process-1', workspace_id: 'workspace-1', name: 'saved-shell', status: 'running', restartable: true }],
      process: { id: 'process-1', workspace_id: 'workspace-1', name: 'saved-shell', status: 'running', restartable: true },
      loading: false, error: null, openingShell: false, startingCommand: false,
      restartingProcessId: null, readOnly: true, onSelectProcess: () => undefined,
      onOpenShell: () => undefined, onRunCommand: async () => undefined, onSignal: () => undefined,
      onRestart: () => undefined, onProcessChanged: () => undefined,
    }))
    expect(terminal).toContain('saved-shell')
    expect(terminal).toContain('aria-readonly="true"')
    expect(terminal).toContain('Terminal output is available read only')
    expect(terminal).not.toContain('inert')
  })

  it('keeps plain Tab in xterm and exposes the keyboard escape description', () => {
    let armed = false
    const moved: string[] = []
    const event = {
      key: 'Tab', shiftKey: false, type: 'keydown',
      preventDefault: vi.fn(), stopPropagation: vi.fn(),
    }
    const handledByXterm = routeTerminalKeyEvent(event, armed, (next) => { armed = next }, (direction) => {
      moved.push(direction)
      return true
    })
    const emitted: string[] = []
    if (handledByXterm) emitted.push('\t')
    expect(handledByXterm).toBe(true)
    expect(armed).toBe(false)
    expect(moved).toEqual([])
    expect(emitted).toEqual(['\t'])
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(terminalSource).toContain('Tab completes in terminal. Press Escape, then Tab to leave.')
    expect(terminalSource).toContain('aria-describedby={keyboardHelpId}')
  })

  it('routes Escape then Tab or Shift+Tab out of xterm', () => {
    let armed = false
    const directions: string[] = []
    const key = (value: string, shiftKey = false) => ({
      key: value, shiftKey, type: 'keydown', preventDefault: vi.fn(), stopPropagation: vi.fn(),
    })
    const move = (direction: 'forward' | 'backward') => { directions.push(direction); return true }
    expect(routeTerminalKeyEvent(key('Escape'), armed, (next) => { armed = next }, move)).toBe(true)
    expect(armed).toBe(true)
    const forward = key('Tab')
    expect(routeTerminalKeyEvent(forward, armed, (next) => { armed = next }, move)).toBe(false)
    expect(armed).toBe(false)
    expect(forward.preventDefault).toHaveBeenCalledOnce()
    expect(directions).toEqual(['forward'])

    routeTerminalKeyEvent(key('Escape'), armed, (next) => { armed = next }, move)
    const backward = key('Tab', true)
    expect(routeTerminalKeyEvent(backward, armed, (next) => { armed = next }, move)).toBe(false)
    expect(backward.preventDefault).toHaveBeenCalledOnce()
    expect(directions).toEqual(['forward', 'backward'])
  })

  it('keeps saved workspace context/process content in the accessibility tree while actions are disabled', () => {
    vi.stubGlobal('window', { location: { hostname: 'localhost' } })
    const context = renderToStaticMarkup(createElement(ContextPane, {
      readOnly: true,
      context: { status: 'ready', error: null, data: [{
        id: 'context-1', kind: 'decision', source: 'release-plan.md', content: 'Retained release decision',
        tokens: 42, pinned: true, provenance: null,
      }] },
      onTogglePin: async () => undefined,
    }))
    expect(context).toContain('Retained release decision')
    expect(context).toContain('disabled=""')
    expect(context).not.toContain('aria-hidden="true"')
    expect(context).not.toContain('inert')

    const processes = renderToStaticMarkup(createElement(ProcessesPane, {
      readOnly: true, activeId: 'process-1',
      processes: { status: 'ready', error: null, data: [{
        id: 'process-1', name: 'saved-test', command: 'npm test', status: 'running',
        restartable: true, pid: 123, exit_code: null, started_at: '2026-08-02T10:00:00Z', ports: [],
      }] },
      onAttach: () => undefined, onSignal: async () => undefined, onRestart: async () => undefined,
    }))
    expect(processes).toContain('npm test')
    expect(processes).toContain('disabled=""')
    expect(processes).not.toContain('inert')
    vi.unstubAllGlobals()
  })

  it('propagates read only from App through both canonical runtime surfaces and guards named mutation paths', () => {
    expect(appSource).toContain("readOnly={connectionState !== 'live'}")
    expect(agentHomeSource).toContain('if (readOnly || !selectedSession) return')
    expect(agentHomeSource).toContain('const workspace = runtime.workspace')
    expect(agentHomeSource).toContain('if (readOnly || !workspace || openingShell) return')
    expect(agentHomeSource).toContain('if (readOnly || restartingProcessId) return')
    expect(cockpitSource).toContain('if (readOnly || openingShellRef.current) return')
    expect(cockpitSource).toContain('if (readOnly || processes.status !== \'ready\') return')
    expect(terminalSource).toContain('if (!batch?.data || readOnlyRef.current) return')
    expect(terminalSource).toContain('if (readOnlyRef.current) return')
  })
})
