import React from 'react'
import { ProjectGrid } from './Board'
import { CommandCenterState } from './CommandCenterSurfaces'
import { MessagesView } from './MessagesView'
import { ShippedView } from './ShippedView'
import { Snapshot } from './api'
import {
  BACKLOG_PANES, BACKLOG_PANE_KEY, BOARD_TABS, BacklogPane, BoardTab, GIT_PANES,
  GIT_PANE_KEY, GitPane, resolveBacklogPane, resolveGitPane,
} from './boardNavigation'
import './boardSection.css'

// the board's Workspace tab is a terminal only (#159); the full runtime cockpit
// (diffs, evidence, deliveries, policies) lives on the Advanced surface
const WorkspaceTerminal = React.lazy(() => import('./WorkspaceTerminal').then((module) => ({ default: module.WorkspaceTerminal })))
const TeamsView = React.lazy(() => import('./TeamsView').then((module) => ({ default: module.TeamsView })))
const KanbanView = React.lazy(() => import('./KanbanView').then((module) => ({ default: module.KanbanView })))
const RoadmapView = React.lazy(() => import('./RoadmapView').then((module) => ({ default: module.RoadmapView })))
const FunnelView = React.lazy(() => import('./FunnelView').then((module) => ({ default: module.FunnelView })))
// promoted out of the old Advanced/Knowledge section (#172); real citation browse/review UI
const KnowledgeView = React.lazy(() => import('./KnowledgeView').then((module) => ({ default: module.KnowledgeView })))

const paneLoader = (label: string) => (
  <div className="os-view-loading" aria-label={label}><span /><span /><span /></div>
)

// Backlog = the kanban board and the roadmap builder, one tab, two panes. The pane
// is remembered per browser, and ?view=roadmap (the old global route) opens Roadmap.
function BacklogPanel({ snaps, focused, onChange }: { snaps: Snapshot[]; focused: boolean; onChange: () => void }) {
  const [pane, setPane] = React.useState<BacklogPane>(() => {
    try { return resolveBacklogPane(localStorage.getItem(BACKLOG_PANE_KEY), location.search) } catch { return 'kanban' }
  })
  const pick = (next: BacklogPane) => {
    setPane(next)
    try { localStorage.setItem(BACKLOG_PANE_KEY, next) } catch { /* private mode */ }
  }

  return (
    <div className="backlog-panel">
      <nav className="backlog-panes" aria-label="Backlog views" role="tablist">
        {BACKLOG_PANES.map((item) => (
          <button key={item.id} id={`backlog-pane-${item.id}`} type="button" role="tab"
            className={pane === item.id ? 'backlog-pane-tab active' : 'backlog-pane-tab'}
            aria-selected={pane === item.id} aria-controls="backlog-pane-panel"
            onClick={() => pick(item.id)}>{item.label}</button>
        ))}
      </nav>
      <div className="backlog-pane-body" id="backlog-pane-panel" role="tabpanel"
        aria-labelledby={`backlog-pane-${pane}`}>
        {pane === 'kanban'
          ? <React.Suspense fallback={paneLoader('Loading kanban')}>
              <KanbanView snaps={snaps} onChange={onChange} />
            </React.Suspense>
          : pane === 'funnel'
            ? <React.Suspense fallback={paneLoader('Loading funnel')}>
                <FunnelView snaps={snaps} onChange={onChange} />
              </React.Suspense>
            : <React.Suspense fallback={paneLoader('Loading roadmap')}>
                <RoadmapView snaps={snaps} focused={focused} onChange={onChange} />
              </React.Suspense>}
      </div>
    </div>
  )
}

// Git = the project's history in two panes over the same annotated log: Commits
// (every commit on the working branch) and Pushes (only what reached the remote).
// The pane is remembered per browser; a browser that last sat on the retired
// Shipped tab lands on Pushes (#181).
function GitPanel({ snaps, focused, onChange }: { snaps: Snapshot[]; focused: boolean; onChange: () => void }) {
  const [pane, setPane] = React.useState<GitPane>(() => {
    try { return resolveGitPane(localStorage.getItem(GIT_PANE_KEY), localStorage.getItem('orchestra-board-tab')) } catch { return 'commits' }
  })
  const pick = (next: GitPane) => {
    setPane(next)
    try { localStorage.setItem(GIT_PANE_KEY, next) } catch { /* private mode */ }
  }

  return (
    <div className="git-panel">
      <nav className="git-panes" aria-label="Git views" role="tablist">
        {GIT_PANES.map((item) => (
          <button key={item.id} id={`git-pane-${item.id}`} type="button" role="tab"
            className={pane === item.id ? 'git-pane-tab active' : 'git-pane-tab'}
            aria-selected={pane === item.id} aria-controls="git-pane-panel"
            onClick={() => pick(item.id)}>{item.label}</button>
        ))}
      </nav>
      <div className="git-pane-body" id="git-pane-panel" role="tabpanel"
        aria-labelledby={`git-pane-${pane}`}>
        <ShippedView snaps={snaps} focused={focused} source={pane} onChange={onChange} />
      </div>
    </div>
  )
}

type Props = {
  tab: BoardTab
  snaps: Snapshot[]
  focused: boolean
  openMessages: number
  onTabChange: (tab: BoardTab) => void
  onChange: () => void
}

export function BoardSection({ tab, snaps, focused, openMessages, onTabChange, onChange }: Props) {
  return (
    <section className={`board-section board-section-${tab}`}>
      <nav className="board-section-tabs" aria-label="Board views" role="tablist">
        {BOARD_TABS.map((item) => (
          <button key={item.id} id={`board-tab-${item.id}`} type="button" role="tab"
            className={tab === item.id ? 'board-section-tab active' : 'board-section-tab'}
            aria-selected={tab === item.id} aria-controls="board-section-panel"
            onClick={() => onTabChange(item.id)}>
            {item.label}
            {item.id === 'messages' && openMessages > 0 && <span className="board-section-count">{openMessages}</span>}
          </button>
        ))}
      </nav>

      <div className="board-section-panel" id="board-section-panel" role="tabpanel"
        aria-labelledby={`board-tab-${tab}`}>
        {tab === 'overview'
          ? <ProjectGrid snaps={snaps} focused={focused} onChange={onChange} />
          : tab === 'kanban'
            ? <BacklogPanel snaps={snaps} focused={focused} onChange={onChange} />
          : tab === 'wiki'
            ? snaps[0]
              ? <React.Suspense fallback={paneLoader('Loading wiki')}>
                  <KnowledgeView boardId={snaps[0].board.id} />
                </React.Suspense>
              : <CommandCenterState kind="empty" title="Choose one project" detail="The wiki is scoped to one project. Select a project to browse its knowledge." />
          : tab === 'agents'
            ? <React.Suspense fallback={<div className="os-view-loading" aria-label="Loading Teams"><span /><span /><span /></div>}>
                <TeamsView snaps={snaps} onChange={onChange} />
              </React.Suspense>
          : tab === 'messages'
            ? <MessagesView snaps={snaps} focused={focused} onChange={onChange} />
            : tab === 'workspace'
              ? <React.Suspense fallback={<div className="os-view-loading" aria-label="Loading terminal"><span /><span /><span /></div>}>
                  <WorkspaceTerminal snaps={snaps} />
                </React.Suspense>
              : <GitPanel snaps={snaps} focused={focused} onChange={onChange} />}
      </div>
    </section>
  )
}
