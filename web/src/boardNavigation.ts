export const BOARD_TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'messages', label: 'Messages' },
  { id: 'workspace', label: 'Workspace' },
] as const

export type BoardTab = typeof BOARD_TABS[number]['id']
export type PrimaryView = 'board' | 'roadmap' | 'timeline' | 'shipped'

export type StoredNavigation = {
  view: PrimaryView
  boardTab: BoardTab
}

const primaryViews = new Set<PrimaryView>(['board', 'roadmap', 'timeline', 'shipped'])
const boardTabs = new Set<BoardTab>(BOARD_TABS.map((tab) => tab.id))

export function resolveStoredNavigation(savedView: string | null, savedBoardTab: string | null): StoredNavigation {
  if (savedView === 'messages') return { view: 'board', boardTab: 'messages' }
  if (savedView === 'workspaces') return { view: 'board', boardTab: 'workspace' }

  return {
    view: primaryViews.has(savedView as PrimaryView) ? savedView as PrimaryView : 'board',
    boardTab: boardTabs.has(savedBoardTab as BoardTab) ? savedBoardTab as BoardTab : 'overview',
  }
}
