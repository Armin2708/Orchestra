export const BOARD_TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'agents', label: 'Agents' },
  { id: 'messages', label: 'Messages' },
  { id: 'workspace', label: 'Workspace' },
  { id: 'timeline', label: 'Timeline' },
  { id: 'shipped', label: 'Shipped' },
] as const

export type BoardTab = typeof BOARD_TABS[number]['id']
export type PrimaryView = 'board' | 'roadmap' | 'settings'

export type StoredNavigation = {
  view: PrimaryView
  boardTab: BoardTab
}

const primaryViews = new Set<PrimaryView>(['board', 'roadmap', 'settings'])
const boardTabs = new Set<BoardTab>(BOARD_TABS.map((tab) => tab.id))

export function resolveStoredNavigation(savedView: string | null, savedBoardTab: string | null): StoredNavigation {
  if (savedView === 'agents') return { view: 'board', boardTab: 'agents' }
  if (savedView === 'messages') return { view: 'board', boardTab: 'messages' }
  if (savedView === 'workspaces') return { view: 'board', boardTab: 'workspace' }
  if (savedView === 'timeline') return { view: 'board', boardTab: 'timeline' }
  if (savedView === 'shipped') return { view: 'board', boardTab: 'shipped' }

  return {
    view: primaryViews.has(savedView as PrimaryView) ? savedView as PrimaryView : 'board',
    boardTab: boardTabs.has(savedBoardTab as BoardTab) ? savedBoardTab as BoardTab : 'overview',
  }
}
