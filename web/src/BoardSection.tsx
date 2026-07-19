import React from 'react'
import { ProjectGrid } from './Board'
import { MessagesView } from './MessagesView'
import { Snapshot } from './api'
import { BOARD_TABS, BoardTab } from './boardNavigation'
import './boardSection.css'

const WorkspaceCockpit = React.lazy(() => import('./WorkspaceCockpit').then((module) => ({ default: module.WorkspaceCockpit })))

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
          : tab === 'messages'
            ? <MessagesView snaps={snaps} focused={focused} onChange={onChange} />
            : <React.Suspense fallback={<div className="os-view-loading" aria-label="Loading workspace cockpit"><span /><span /><span /></div>}>
                <WorkspaceCockpit snaps={snaps} onChange={onChange} />
              </React.Suspense>}
      </div>
    </section>
  )
}
