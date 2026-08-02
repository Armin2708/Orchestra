import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { BOARD_TABS, resolveStoredNavigation } from '../web/src/boardNavigation.js'

describe('board-local navigation', () => {
  it('keeps operational and history views together under Board', () => {
    expect(BOARD_TABS).toEqual([
      { id: 'overview', label: 'Overview' },
      { id: 'agents', label: 'Agents' },
      { id: 'messages', label: 'Messages' },
      { id: 'workspace', label: 'Workspace' },
      { id: 'timeline', label: 'Timeline' },
      { id: 'shipped', label: 'Shipped' },
    ])
  })

  it('migrates the old global routes into their Board tabs', () => {
    expect(resolveStoredNavigation('agents', null)).toEqual({ view: 'board', boardTab: 'agents' })
    expect(resolveStoredNavigation('messages', null)).toEqual({ view: 'board', boardTab: 'messages' })
    expect(resolveStoredNavigation('workspaces', null)).toEqual({ view: 'board', boardTab: 'workspace' })
    expect(resolveStoredNavigation('timeline', null)).toEqual({ view: 'board', boardTab: 'timeline' })
    expect(resolveStoredNavigation('shipped', null)).toEqual({ view: 'board', boardTab: 'shipped' })
    expect(resolveStoredNavigation('board', 'messages')).toEqual({ view: 'board', boardTab: 'messages' })
    expect(resolveStoredNavigation('board', 'agents')).toEqual({ view: 'board', boardTab: 'agents' })
    expect(resolveStoredNavigation('board', 'timeline')).toEqual({ view: 'board', boardTab: 'timeline' })
    expect(resolveStoredNavigation('board', 'shipped')).toEqual({ view: 'board', boardTab: 'shipped' })
    expect(resolveStoredNavigation('roadmap', 'workspace')).toEqual({ view: 'roadmap', boardTab: 'workspace' })
    expect(resolveStoredNavigation('open-work', 'overview')).toEqual({ view: 'open-work', boardTab: 'overview' })
    expect(resolveStoredNavigation('organization', 'overview')).toEqual({ view: 'organization', boardTab: 'overview' })
    expect(resolveStoredNavigation('settings', 'overview')).toEqual({ view: 'settings', boardTab: 'overview' })
    expect(resolveStoredNavigation('unknown', 'unknown')).toEqual({ view: 'board', boardTab: 'overview' })
  })

  it('removes Board-local views from the global header', () => {
    const app = readFileSync(new URL('../web/src/App.tsx', import.meta.url), 'utf8')
    const boardSection = readFileSync(new URL('../web/src/BoardSection.tsx', import.meta.url), 'utf8')
    const globalTabs = app.match(/<nav className="view-tabs">([\s\S]*?)<\/nav>/)?.[1] ?? ''
    expect(globalTabs).not.toContain("pickView('messages')")
    expect(globalTabs).not.toContain("pickView('workspaces')")
    expect(globalTabs).not.toContain("pickView('timeline')")
    expect(globalTabs).not.toContain("pickView('shipped')")
    expect(app).toContain('<CanonicalActivity')
    expect(boardSection).toContain('<TimelineView')
    expect(boardSection).toContain('<ShippedView')
    expect(boardSection).toContain('<AgentHome')
  })

  it('reveals circular kill controls only from agent hover or focus', () => {
    const css = readFileSync(new URL('../web/src/styles.css', import.meta.url), 'utf8')
    expect(css).toMatch(/\.crew-slot \.fire \{[\s\S]*?border-radius: 50%;[\s\S]*?opacity: 0;/)
    expect(css).toMatch(/\.crew-slot:hover \.fire, \.crew-slot:focus-within \.fire \{ opacity: 1;/)
    expect(css).toMatch(/\.net-kill \{[\s\S]*?border-radius: 50%;[\s\S]*?opacity: 0;/)
    expect(css).toMatch(/\.net-node:hover \.net-kill, \.net-node:focus-within \.net-kill \{ opacity: 1;/)
  })
})
