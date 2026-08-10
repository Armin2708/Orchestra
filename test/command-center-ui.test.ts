import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  CommandCenter,
  CommandCenterWalkthrough,
  TerminalTouchControls,
} from '../web/src/CommandCenter.js'
import { CommandCenterState } from '../web/src/CommandCenterSurfaces.js'
import { commandCenterStatus } from '../web/src/commandCenterModel.js'
import { resolveAttentionItem } from '../web/src/NeedsYou.js'

const requireFromWeb = createRequire(new URL('../web/package.json', import.meta.url))
const { createElement } = requireFromWeb('react') as {
  createElement: (component: unknown, props: Record<string, unknown>, ...children: unknown[]) => unknown
}
const { renderToStaticMarkup } = requireFromWeb('react-dom/server') as {
  renderToStaticMarkup: (node: unknown) => string
}
const css = readFileSync(new URL('../web/src/commandCenter.css', import.meta.url), 'utf8')
const shellSource = readFileSync(new URL('../web/src/CommandCenter.tsx', import.meta.url), 'utf8')
const surfacesSource = readFileSync(new URL('../web/src/CommandCenterSurfaces.tsx', import.meta.url), 'utf8')
const appSource = readFileSync(new URL('../web/src/App.tsx', import.meta.url), 'utf8')

describe('unified command center component contract', () => {
  it('renders project navigation, global search, saved views, preferences, and explicit offline state', () => {
    const markup = renderToStaticMarkup(createElement(CommandCenter, {
      projectName: 'Orchestra',
      projectId: 7,
      section: 'work',
      counts: { work: 4, agents: 2 },
      searchRecords: [],
      connectionState: 'offline',
      onNavigate: () => undefined,
      children: createElement('p', {}, 'Canonical work'),
    }))
    for (const label of ['Work', 'Agents']) {
      expect(markup).toContain(`>${label}<`)
    }
    expect(markup).not.toMatch(/>Discussions<|>Knowledge<|>Outcomes<|>Activity</)
    expect(markup).toContain('Project command center')
    expect(markup).toContain('Search the project command center')
    expect(markup).toContain('Save current')
    expect(markup).toContain('These settings change presentation only. Runtime records remain canonical.')
    expect(markup).toContain('Offline · read only')
    expect(markup).toContain('Mutating controls are disabled until the daemon reconnects.')
    expect(markup).toContain('role="tablist"')
    expect(markup).toContain('role="tabpanel"')
    expect(markup).toContain('Skip to project content')
    expect(markup).toContain('Canonical work')
    expect(markup).toContain('data-read-only="true"')
    expect(markup).toContain('aria-describedby="cc-offline-notice"')
    expect(markup).not.toContain('inert')
    expect(shellSource).toContain('savedViewsStorageKey(projectId)')
  })

  it('renders all state variants with actionable semantics', () => {
    for (const kind of ['loading', 'empty', 'stale', 'offline', 'error', 'unsupported'] as const) {
      const markup = renderToStaticMarkup(createElement(CommandCenterState, {
        kind,
        detail: `${kind} detail`,
        action: { label: 'Retry', onClick: () => undefined },
      }))
      expect(markup).toContain(`${kind} detail`)
      expect(markup).toContain('Retry')
      expect(markup).toMatch(/role="(alert|status)"/)
    }
  })

  it('keeps offline attention state readable while fail-closing resolution mutations', async () => {
    const resolver = vi.fn(async () => undefined)
    await expect(resolveAttentionItem('attention-1', true, resolver)).resolves.toBe(false)
    expect(resolver).not.toHaveBeenCalled()
    await expect(resolveAttentionItem('attention-1', false, resolver)).resolves.toBe(true)
    expect(resolver).toHaveBeenCalledWith('attention-1')
    expect(appSource).toContain("readOnly={connectionState !== 'live'}")
    expect(appSource).toContain('commandCenterProjectProjection({')
    expect(appSource).toContain('boardId={focus === \'all\' ? null')
    expect(appSource).toContain('resolveCommandCenterProjectFocus(snaps, focus)')
    expect(appSource).not.toContain('visible.length > 0 ? visible : snaps')
  })

  it('makes terminal controls touch-safe and fails closed in view-only mode', () => {
    const viewOnly = renderToStaticMarkup(createElement(TerminalTouchControls, {
      processStatus: commandCenterStatus('process', 'running'),
      readOnly: true,
    }))
    expect(viewOnly).toContain('View only')
    expect(viewOnly).not.toContain('Interrupt')
    expect(viewOnly).not.toContain('New shell')

    const writable = renderToStaticMarkup(createElement(TerminalTouchControls, {
      processStatus: commandCenterStatus('process', 'running'),
      readOnly: false,
      onInterrupt: () => undefined,
      onStop: () => undefined,
      onNewShell: () => undefined,
    }))
    expect(writable).toContain('Interrupt')
    expect(writable).toContain('Stop')
    expect(writable).toContain('New shell')
  })

  it('walks through the real Create, Run, Inspect, Review lifecycle in a focus-trapped dialog', () => {
    const markup = renderToStaticMarkup(createElement(CommandCenterWalkthrough, {
      open: true,
      onClose: () => undefined,
    }))
    expect(markup).toContain('Create')
    expect(markup).toContain('Run')
    expect(markup).toContain('Inspect')
    expect(markup).toContain('Review')
    expect(markup).toContain('Creating or inspecting a workspace does not start a model.')
    expect(markup).toContain('role="dialog"')
    expect(markup).toContain('aria-modal="true"')
    expect(shellSource).toContain('useModalFocusTrap(open, dialogRef, onClose, closeRef)')
  })

  it('defines desktop, tablet, phone, coarse-pointer, reduced-motion, and forced-color contracts', () => {
    expect(css).toContain('@media (max-width: 1050px)')
    expect(css).toContain('@media (max-width: 700px)')
    expect(css).toContain('@media (pointer: coarse)')
    expect(css).toContain('@media (prefers-reduced-motion: reduce)')
    expect(css).toContain('@media (forced-colors: active)')
    expect(css).toContain('min-height: 44px')
    expect(css).not.toContain('h-screen')
    expect(shellSource).not.toContain('dangerouslySetInnerHTML')
    expect(surfacesSource).not.toContain('dangerouslySetInnerHTML')
  })

  it('mounts the command center behind Advanced with only Work and Agents surfaces', () => {
    expect(appSource).toContain('<CommandCenter')
    expect(appSource).toContain("commandSection === 'work'")
    expect(appSource).toContain('<CanonicalAgentHome')
    expect(appSource).not.toContain('CanonicalDiscussionDetail')
    expect(appSource).not.toContain('KnowledgeBrowse')
    expect(appSource).not.toContain('OutcomeDashboard')
    expect(appSource).not.toContain('CanonicalActivity')
    expect(appSource).toContain("window.addEventListener('popstate', restoreDeepLink)")
    expect(appSource).toContain('>Board</button>')
    expect(appSource).toContain('>Advanced</button>')
    expect(appSource).toContain("const commandCenterActive = view === 'open-work'")
  })
})
