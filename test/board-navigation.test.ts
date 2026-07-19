import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { BOARD_TABS, resolveStoredNavigation } from '../web/src/boardNavigation.js'

describe('board-local navigation', () => {
  it('keeps overview, messages, and workspace together under Board', () => {
    expect(BOARD_TABS).toEqual([
      { id: 'overview', label: 'Overview' },
      { id: 'messages', label: 'Messages' },
      { id: 'workspace', label: 'Workspace' },
    ])
  })

  it('migrates the old global message and workspace routes', () => {
    expect(resolveStoredNavigation('messages', null)).toEqual({ view: 'board', boardTab: 'messages' })
    expect(resolveStoredNavigation('workspaces', null)).toEqual({ view: 'board', boardTab: 'workspace' })
    expect(resolveStoredNavigation('board', 'messages')).toEqual({ view: 'board', boardTab: 'messages' })
    expect(resolveStoredNavigation('roadmap', 'workspace')).toEqual({ view: 'roadmap', boardTab: 'workspace' })
    expect(resolveStoredNavigation('unknown', 'unknown')).toEqual({ view: 'board', boardTab: 'overview' })
  })

  it('removes Messages and Workspaces from the global header', () => {
    const app = readFileSync(new URL('../web/src/App.tsx', import.meta.url), 'utf8')
    const globalTabs = app.match(/<nav className="view-tabs">([\s\S]*?)<\/nav>/)?.[1] ?? ''
    expect(globalTabs).not.toContain("pickView('messages')")
    expect(globalTabs).not.toContain("pickView('workspaces')")
    expect(app).toContain('<BoardSection')
  })

  it('reveals circular kill controls only from agent hover or focus', () => {
    const css = readFileSync(new URL('../web/src/styles.css', import.meta.url), 'utf8')
    expect(css).toMatch(/\.crew-slot \.fire \{[\s\S]*?border-radius: 50%;[\s\S]*?opacity: 0;/)
    expect(css).toMatch(/\.crew-slot:hover \.fire, \.crew-slot:focus-within \.fire \{ opacity: 1;/)
    expect(css).toMatch(/\.net-kill \{[\s\S]*?border-radius: 50%;[\s\S]*?opacity: 0;/)
    expect(css).toMatch(/\.net-node:hover \.net-kill, \.net-node:focus-within \.net-kill \{ opacity: 1;/)
  })
})
