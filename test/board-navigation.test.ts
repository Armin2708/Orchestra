import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  BACKLOG_PANES, BOARD_TABS, GIT_PANES, resolveBacklogPane, resolveGitPane,
  resolveLocationNavigation, resolveStoredNavigation,
} from '../web/src/boardNavigation.js'

describe('board-local navigation', () => {
  it('keeps operational and history views together under Board', () => {
    expect(BOARD_TABS).toEqual([
      { id: 'overview', label: 'Overview' },
      { id: 'messages', label: 'Inbox' },
      { id: 'agents', label: 'Teams' },
      { id: 'kanban', label: 'Backlog' },
      { id: 'wiki', label: 'Wiki' },
      { id: 'workspace', label: 'Workspace' },
      { id: 'git', label: 'Git' },
      // rendered only while the cloud project is focused (BoardSection gates on
      // its cloudPanel prop), but part of the closed tab vocabulary like any other
      { id: 'cloud', label: 'Cloud agents' },
    ])
  })

  it('migrates the old global routes into their Board tabs', () => {
    expect(resolveStoredNavigation('agents', null)).toEqual({ view: 'board', boardTab: 'agents' })
    expect(resolveStoredNavigation('messages', null)).toEqual({ view: 'board', boardTab: 'messages' })
    expect(resolveStoredNavigation('workspaces', null)).toEqual({ view: 'board', boardTab: 'workspace' })
    // Timeline and Shipped merged into the Git tab (#181): old views and old saved tabs both land there
    expect(resolveStoredNavigation('timeline', null)).toEqual({ view: 'board', boardTab: 'git' })
    expect(resolveStoredNavigation('shipped', null)).toEqual({ view: 'board', boardTab: 'git' })
    expect(resolveStoredNavigation('board', 'messages')).toEqual({ view: 'board', boardTab: 'messages' })
    expect(resolveStoredNavigation('board', 'agents')).toEqual({ view: 'board', boardTab: 'agents' })
    expect(resolveStoredNavigation('board', 'timeline')).toEqual({ view: 'board', boardTab: 'git' })
    expect(resolveStoredNavigation('board', 'shipped')).toEqual({ view: 'board', boardTab: 'git' })
    expect(resolveStoredNavigation('board', 'git')).toEqual({ view: 'board', boardTab: 'git' })
    expect(resolveStoredNavigation('roadmap', 'workspace')).toEqual({ view: 'board', boardTab: 'kanban' })
    // Advanced/open-work is retired (#210); everything it showed lives on Board tabs now
    expect(resolveStoredNavigation('open-work', 'overview')).toEqual({ view: 'board', boardTab: 'overview' })
    expect(resolveStoredNavigation('settings', 'overview')).toEqual({ view: 'settings', boardTab: 'overview' })
    // Collaborate/Organization were removed from the More menu; the routes just fall back to board now
    expect(resolveStoredNavigation('organization', 'overview')).toEqual({ view: 'board', boardTab: 'overview' })
    expect(resolveStoredNavigation('collaboration', 'overview')).toEqual({ view: 'board', boardTab: 'overview' })
    expect(resolveStoredNavigation('unknown', 'unknown')).toEqual({ view: 'board', boardTab: 'overview' })
  })

  it('keeps the kanban and the roadmap builder together in the Backlog tab', () => {
    expect(BACKLOG_PANES).toEqual([
      { id: 'kanban', label: 'Kanban' },
      { id: 'roadmap', label: 'Roadmap' },
      { id: 'funnel', label: 'Funnel' },
    ])
    expect(resolveBacklogPane(null, '')).toBe('kanban')
    expect(resolveBacklogPane('roadmap', '')).toBe('roadmap')
    expect(resolveBacklogPane('nonsense', '')).toBe('kanban')
    // the retired global route opens the pane it used to be
    expect(resolveBacklogPane(null, '?view=roadmap')).toBe('roadmap')
    expect(resolveLocationNavigation('board', 'overview', '?view=roadmap'))
      .toEqual({ view: 'board', boardTab: 'kanban' })

    const app = readFileSync(new URL('../web/src/App.tsx', import.meta.url), 'utf8')
    const boardSection = readFileSync(new URL('../web/src/BoardSection.tsx', import.meta.url), 'utf8')
    expect(app).not.toContain("pickView('roadmap')")
    expect(boardSection).toContain('<RoadmapView')
    expect(boardSection).toContain('<KanbanView')
    expect(boardSection).toContain('<FunnelView')
  })

  it('opens the simple graph board by default; Advanced/open-work is retired (#210), canonical deep links resolve on Board tabs', () => {
    expect(resolveLocationNavigation(null, null, '')).toEqual({ view: 'board', boardTab: 'overview' })
    expect(resolveLocationNavigation('board', 'messages', '?view=board&board=12'))
      .toEqual({ view: 'board', boardTab: 'messages' })
    expect(resolveLocationNavigation('board', 'overview', '?section=agents&agent=profile-4'))
      .toEqual({ view: 'board', boardTab: 'overview' })
    expect(resolveLocationNavigation('board', 'overview', '?card=44'))
      .toEqual({ view: 'board', boardTab: 'overview' })
    expect(resolveLocationNavigation('board', 'overview', '?attention=approval-2'))
      .toEqual({ view: 'board', boardTab: 'overview' })
    // 'open-work' is no longer a valid primary view; the stale param is ignored
    expect(resolveLocationNavigation('board', 'overview', '?view=open-work'))
      .toEqual({ view: 'board', boardTab: 'overview' })
    expect(resolveLocationNavigation('board', 'overview', '?view=settings&card=44'))
      .toEqual({ view: 'settings', boardTab: 'overview' })
  })

  it('removes Board-local views from the global header', () => {
    const app = readFileSync(new URL('../web/src/App.tsx', import.meta.url), 'utf8')
    const boardSection = readFileSync(new URL('../web/src/BoardSection.tsx', import.meta.url), 'utf8')
    const globalTabs = app.match(/<nav className="view-tabs">([\s\S]*?)<\/nav>/)?.[1] ?? ''
    expect(globalTabs).not.toContain("pickView('messages')")
    expect(globalTabs).not.toContain("pickView('workspaces')")
    expect(globalTabs).not.toContain("pickView('timeline')")
    expect(globalTabs).not.toContain("pickView('shipped')")
    expect(app).not.toContain('CanonicalActivity')
    // the activity TimelineView is retired; both Git panes render the annotated ship log
    expect(boardSection).not.toContain('TimelineView')
    expect(boardSection).toContain('<ShippedView')
    expect(boardSection).toContain('<GitPanel')
    expect(boardSection).toContain('<TeamsView')
  })

  it('keeps commits and pushes together in the Git tab', () => {
    expect(GIT_PANES).toEqual([
      { id: 'commits', label: 'Commits' },
      { id: 'pushes', label: 'Pushes' },
    ])
    expect(resolveGitPane(null)).toBe('commits')
    expect(resolveGitPane('pushes')).toBe('pushes')
    expect(resolveGitPane('nonsense')).toBe('commits')
    // one-shot migration: a browser that last sat on the retired Shipped tab lands on Pushes
    expect(resolveGitPane(null, 'shipped')).toBe('pushes')
    expect(resolveGitPane(null, 'timeline')).toBe('commits')
    expect(resolveGitPane('commits', 'shipped')).toBe('commits')
  })

  it('keeps the spatial agent graph reachable now that Advanced/open-work is fully retired (#210)', () => {
    const app = readFileSync(new URL('../web/src/App.tsx', import.meta.url), 'utf8')
    const board = readFileSync(new URL('../web/src/Board.tsx', import.meta.url), 'utf8')
    expect(app).toContain("import { BoardSection } from './BoardSection'")
    expect(app).toContain('<BoardSection')
    expect(app).not.toContain('commandCenterActive')
    expect(app).not.toContain("'open-work'")
    expect(app).toContain("focusScope.kind === 'project'")
    expect(app).not.toContain("focusScope.kind === 'focused'")
    expect(app).toContain('>Board</button>')
    expect(app).not.toContain('>Advanced</button>')
    expect(board).toContain('<NetworkView')
  })

  it('gives focused and multi-project graphs a real canvas height', () => {
    const css = readFileSync(new URL('../web/src/styles.css', import.meta.url), 'utf8')
    expect(css).toMatch(/\.projects\.focused \{[\s\S]*?grid-template-rows: minmax\(0, 1fr\)/)
    // formatting-tolerant: the rule was reformatted to multi-line in 7ed4f58
    expect(css).toMatch(/\.projects:not\(\.focused\) \.project\.network-mode \{[\s\S]*?min-height: 500px;/)
    expect(css).toContain('.projects:not(.focused) .net-wrap .network { min-height: 440px; }')
  })

  it('uses a local password and temporary browser session instead of asking users for a token', () => {
    const app = readFileSync(new URL('../web/src/App.tsx', import.meta.url), 'utf8')
    expect(app).toContain('Create your password')
    expect(app).toContain('Unlock board')
    expect(app).toContain('authenticateLocalOwnerPassword')
    expect(app).not.toContain('Paste token')
    expect(app).not.toContain('<pre>orchestra token</pre>')
  })

  it('reveals circular kill controls only from agent hover or focus', () => {
    const css = readFileSync(new URL('../web/src/styles.css', import.meta.url), 'utf8')
    expect(css).toMatch(/\.crew-slot \.fire \{[\s\S]*?border-radius: 50%;[\s\S]*?opacity: 0;/)
    expect(css).toMatch(/\.crew-slot:hover \.fire, \.crew-slot:focus-within \.fire \{ opacity: 1;/)
    expect(css).toMatch(/\.net-kill \{[\s\S]*?border-radius: 50%;[\s\S]*?opacity: 0;/)
    expect(css).toMatch(/\.net-node:hover \.net-kill, \.net-node:focus-within \.net-kill \{ opacity: 1;/)
  })
})
