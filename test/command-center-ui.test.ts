import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  CommandCenter,
  CommandCenterWalkthrough,
  TerminalTouchControls,
} from '../web/src/CommandCenter.js'
import {
  CanonicalDiscussionDetail,
  CommandCenterState,
  DependencyVisualization,
} from '../web/src/CommandCenterSurfaces.js'
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
      counts: { work: 4, agents: 2, knowledge: 0, activity: 11 },
      searchRecords: [],
      connectionState: 'offline',
      onNavigate: () => undefined,
      children: createElement('p', {}, 'Canonical work'),
    }))
    for (const label of ['Work', 'Agents', 'Discussions', 'Knowledge', 'Outcomes', 'Activity']) {
      expect(markup).toContain(`>${label}<`)
    }
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
    expect(markup).not.toMatch(/>Discussions<b>/)
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

  it('keeps canonical Discussions explicitly unavailable instead of relabeling Messages', () => {
    const markup = renderToStaticMarkup(createElement(CanonicalDiscussionDetail, {
      discussion: null,
      posts: [],
      backendAvailable: false,
    }))
    expect(markup).toContain('Canonical Discussions are not available')
    expect(markup).toContain('they are not being relabeled as durable Discussion records')
    expect(markup).toContain('fail')
    expect(surfacesSource).toContain('Compatibility transport')
    expect(surfacesSource).toContain('It is not a canonical Discussion')
  })

  it('renders accepted answers with actor, provider, session, time, and safe text', () => {
    const markup = renderToStaticMarkup(createElement(CanonicalDiscussionDetail, {
      backendAvailable: true,
      discussion: {
        id: 'discussion-7', boardId: 7, title: 'Restart <script>plan</script>',
        summary: 'Choose a durable continuation path.', status: 'answered', type: 'question',
        author: 'runtime-operator', updatedAt: '2026-08-02T10:00:00Z',
      },
      posts: [{
        id: 'post-1', author: 'provider-reviewer', actorType: 'agent', provider: 'codex',
        sessionId: 'session-7', body: 'Reattach using exact provider evidence.',
        createdAt: '2026-08-02T10:00:00Z', accepted: true,
      }],
    }))
    expect(markup).toContain('Restart &lt;script&gt;plan&lt;/script&gt;')
    expect(markup).not.toContain('<script>')
    expect(markup).toContain('provider-reviewer')
    expect(markup).toContain('agent · codex')
    expect(markup).toContain('Provider session')
    expect(markup).toContain('Accepted answer')
  })

  it('renders real graph records plus a complete screen-reader relationship list', () => {
    const graph = {
      nodes: [
        { id: 'work:1', kind: 'work' as const, label: 'Runtime UX', detail: 'Canonical job', status: commandCenterStatus('job', 'running'), href: '/?job=1', lane: 1 },
        { id: 'agent:a', kind: 'agent' as const, label: 'runtime-operator', detail: 'Durable assignee', status: commandCenterStatus('agent', 'active'), href: '/?agent=a', lane: 2 },
      ],
      edges: [{ id: 'assigned:1:a', from: 'work:1', to: 'agent:a', kind: 'assigned_to' as const, label: 'Assigned to', blocked: false }],
    }
    const markup = renderToStaticMarkup(createElement(DependencyVisualization, { graph }))
    expect(markup).toContain('Observed relationships')
    expect(markup).toContain('Runtime UX')
    expect(markup).toContain('runtime-operator')
    expect(markup).toContain('Assigned to')
    expect(markup).toContain('aria-label="Dependency relationships"')
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

  it('mounts the command center as the project navigation shell with canonical fail-closed surfaces', () => {
    expect(appSource).toContain('<CommandCenter')
    expect(appSource).toContain("commandSection === 'agents'")
    expect(appSource).toContain('<CanonicalAgentHome')
    expect(appSource).toContain('<CanonicalDiscussionDetail discussion={null} posts={[]} backendAvailable={false}')
    expect(appSource).toContain('<KnowledgeBrowse records={[]} available={false}')
    expect(appSource).toContain("commandSection === 'outcomes'")
    expect(appSource).toContain('<OutcomeDashboard boardId={focus} />')
    expect(appSource).toContain('Outcome evidence is scoped to one canonical project.')
    expect(appSource).toContain("window.addEventListener('popstate', restoreDeepLink)")
    expect(appSource).not.toContain('>Board</button>')
  })
})
