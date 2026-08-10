import React from 'react'
import { ProjectGrid } from './Board'
import { MessagesView } from './MessagesView'
import { ShippedView } from './ShippedView'
import { Snapshot } from './api'
import { BOARD_TABS, BoardTab, GIT_PANES, GIT_PANE_KEY, GitPane, resolveGitPane } from './boardNavigation'
import './boardSection.css'

// the board's Workspace tab is a terminal only (#159); the full runtime cockpit
// (diffs, evidence, deliveries, policies) lives on the Advanced surface
const WorkspaceTerminal = React.lazy(() => import('./WorkspaceTerminal').then((module) => ({ default: module.WorkspaceTerminal })))
const TeamsView = React.lazy(() => import('./TeamsView').then((module) => ({ default: module.TeamsView })))
const KanbanView = React.lazy(() => import('./KanbanView').then((module) => ({ default: module.KanbanView })))

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
            ? <React.Suspense fallback={<div className="os-view-loading" aria-label="Loading kanban"><span /><span /><span /></div>}>
                <KanbanView snaps={snaps} onChange={onChange} />
              </React.Suspense>
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
