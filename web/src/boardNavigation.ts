import type { Snapshot } from './api'

export const BOARD_TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'messages', label: 'Inbox' },
  { id: 'agents', label: 'Teams' },
  // tab id stays 'kanban' so saved navigation and deep links survive the rename
  { id: 'kanban', label: 'Backlog' },
  // promoted out of the old Advanced/Knowledge section (#172)
  { id: 'wiki', label: 'Wiki' },
  { id: 'workspace', label: 'Workspace' },
  // Timeline + Shipped merged into one git-history tab (#181)
  { id: 'git', label: 'Git' },
  // only offered while the cloud project is focused (App gates it): pick and
  // choose which of this machine's agents the organization can see (#319)
  { id: 'cloud', label: 'Cloud agents' },
] as const

export type BoardTab = typeof BOARD_TABS[number]['id']

// the Backlog tab holds two panes: the kanban board and the roadmap builder that
// used to be a global view of its own under More
export const BACKLOG_PANES = [
  { id: 'kanban', label: 'Kanban' },
  { id: 'roadmap', label: 'Roadmap' },
  // the decomposition funnel: epic -> feature spec -> tech spec -> task (#178)
  { id: 'funnel', label: 'Funnel' },
] as const

export type BacklogPane = typeof BACKLOG_PANES[number]['id']
export const BACKLOG_PANE_KEY = 'orchestra-backlog-pane'

const backlogPanes = new Set<BacklogPane>(BACKLOG_PANES.map((pane) => pane.id))

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

// ?view=roadmap used to open the standalone roadmap; it now lands on the Backlog
// tab with the roadmap pane already selected
export function resolveBacklogPane(savedPane: string | null, search = ''): BacklogPane {
  if (new URLSearchParams(search).get('view') === 'roadmap') return 'roadmap'
  return backlogPanes.has(savedPane as BacklogPane) ? savedPane as BacklogPane : 'kanban'
}

export type PrimaryView = 'board' | 'settings'

export type StoredNavigation = {
  view: PrimaryView
  boardTab: BoardTab
}

const primaryViews = new Set<PrimaryView>([
  'board', 'settings',
])
const boardTabs = new Set<BoardTab>(BOARD_TABS.map((tab) => tab.id))

export function resolveStoredNavigation(savedView: string | null, savedBoardTab: string | null): StoredNavigation {
  if (savedView === 'agents') return { view: 'board', boardTab: 'agents' }
  if (savedView === 'messages') return { view: 'board', boardTab: 'messages' }
  if (savedView === 'workspaces') return { view: 'board', boardTab: 'workspace' }
  // Timeline and Shipped are Git-tab panes now, not tabs (or, before that, views)
  if (savedView === 'timeline' || savedView === 'shipped') return { view: 'board', boardTab: 'git' }
  // Advanced/open-work is retired (#210); everything it showed lives on Board tabs now
  if (savedView === 'open-work') return { view: 'board', boardTab: 'overview' }
  if (savedBoardTab === 'timeline' || savedBoardTab === 'shipped') {
    return {
      view: primaryViews.has(savedView as PrimaryView) ? savedView as PrimaryView : 'board',
      boardTab: 'git',
    }
  }
  // the roadmap is a Backlog pane now, not a view
  if (savedView === 'roadmap') return { view: 'board', boardTab: 'kanban' }

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

  if (requestedView === 'roadmap') return { view: 'board', boardTab: 'kanban' }
  if (requestedView === 'settings') {
    return { ...stored, view: requestedView }
  }
  if (requestedView && primaryViews.has(requestedView as PrimaryView)) {
    return { ...stored, view: requestedView as PrimaryView }
  }
  return stored
}

export type ProjectFocus =
  | { kind: 'all'; snapshots: readonly Snapshot[]; projectId: null }
  | { kind: 'project'; snapshots: readonly Snapshot[]; projectId: number }
  | { kind: 'missing'; snapshots: readonly Snapshot[]; projectId: number }

export function normalizeProjectFocus(raw: string | null): number | 'all' {
  if (!raw || raw === 'all') return 'all'
  const parsed = Number(raw)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 'all'
}

export function resolveProjectFocus(
  snapshots: readonly Snapshot[],
  focus: number | 'all',
): ProjectFocus {
  if (focus === 'all') return { kind: 'all', snapshots, projectId: null }
  const snapshot = snapshots.find((candidate) => candidate.board.id === focus)
  return snapshot
    ? { kind: 'project', snapshots: [snapshot], projectId: focus }
    : { kind: 'missing', snapshots: [], projectId: focus }
}
