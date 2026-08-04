export const BOARD_TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'kanban', label: 'Kanban' },
  { id: 'agents', label: 'Teams' },
  { id: 'messages', label: 'Messages' },
  { id: 'workspace', label: 'Workspace' },
  { id: 'timeline', label: 'Timeline' },
  { id: 'shipped', label: 'Shipped' },
] as const

export type BoardTab = typeof BOARD_TABS[number]['id']
export type PrimaryView = 'board' | 'open-work' | 'collaboration' | 'organization' | 'roadmap' | 'settings'

export type StoredNavigation = {
  view: PrimaryView
  boardTab: BoardTab
}

const primaryViews = new Set<PrimaryView>([
  'board', 'open-work', 'collaboration', 'organization', 'roadmap', 'settings',
])
const boardTabs = new Set<BoardTab>(BOARD_TABS.map((tab) => tab.id))
const canonicalRouteKeys = [
  'card', 'agent', 'conversation', 'session', 'job', 'discussion', 'knowledge', 'delivery',
  'workspace', 'process', 'event', 'review', 'attention', 'approval', 'question', 'conflict',
] as const

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

export function resolveLocationNavigation(
  savedView: string | null,
  savedBoardTab: string | null,
  search: string,
): StoredNavigation {
  const stored = resolveStoredNavigation(savedView, savedBoardTab)
  const params = new URLSearchParams(search)
  const requestedView = params.get('view')

  if (requestedView === 'collaboration' || requestedView === 'organization'
    || requestedView === 'roadmap' || requestedView === 'settings') {
    return { ...stored, view: requestedView }
  }
  if (params.has('section') || canonicalRouteKeys.some((key) => params.has(key))) {
    return { ...stored, view: 'open-work' }
  }
  if (requestedView && primaryViews.has(requestedView as PrimaryView)) {
    return { ...stored, view: requestedView as PrimaryView }
  }
  return stored
}
