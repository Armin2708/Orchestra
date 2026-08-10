export const BOARD_TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'kanban', label: 'Kanban' },
  { id: 'agents', label: 'Teams' },
  { id: 'messages', label: 'Messages' },
  { id: 'workspace', label: 'Workspace' },
  // Timeline + Shipped merged into one git-history tab (#181)
  { id: 'git', label: 'Git' },
] as const

export type BoardTab = typeof BOARD_TABS[number]['id']

// the Git tab holds two panes over the same annotated log: every commit on the
// working branch, and only what was pushed to the remote (#181)
export const GIT_PANES = [
  { id: 'commits', label: 'Commits' },
  { id: 'pushes', label: 'Pushes' },
] as const

export type GitPane = typeof GIT_PANES[number]['id']
export const GIT_PANE_KEY = 'orchestra-git-pane'

const gitPanes = new Set<GitPane>(GIT_PANES.map((pane) => pane.id))

// legacyTab is the pre-merge saved board tab ('timeline' | 'shipped'): a browser
// that last sat on Shipped lands on the Pushes pane, everything else on Commits
export function resolveGitPane(savedPane: string | null, legacyTab: string | null = null): GitPane {
  if (gitPanes.has(savedPane as GitPane)) return savedPane as GitPane
  return legacyTab === 'shipped' ? 'pushes' : 'commits'
}
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
  // Timeline and Shipped are Git-tab panes now, not tabs (or, before that, views)
  if (savedView === 'timeline' || savedView === 'shipped') return { view: 'board', boardTab: 'git' }
  if (savedBoardTab === 'timeline' || savedBoardTab === 'shipped') {
    return {
      view: primaryViews.has(savedView as PrimaryView) ? savedView as PrimaryView : 'board',
      boardTab: 'git',
    }
  }

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
