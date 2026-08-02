import { useEffect, useState } from 'react'
import { api } from './api'
import { ProjectDiscussionCenter } from './DiscussionCenter'
import { KnowledgeView } from './KnowledgeView'
import {
  TeamPlanningVisualization,
  type TeamPlanningVisualizationData,
} from './TeamPlanningVisualization'

type CollaborationTab = 'discussions' | 'knowledge' | 'teams'

export function CollaborationCenter({ boardId }: { boardId: number }) {
  const [tab, setTab] = useState<CollaborationTab>('discussions')
  return <main className="collaboration-center">
    <nav className="board-section-tabs" aria-label="Collaboration views" role="tablist">
      {(['discussions', 'knowledge', 'teams'] as const).map((item) => <button key={item}
        type="button" role="tab" aria-selected={tab === item}
        className={tab === item ? 'board-section-tab active' : 'board-section-tab'}
        onClick={() => setTab(item)}>{item[0].toUpperCase() + item.slice(1)}</button>)}
    </nav>
    {tab === 'discussions'
      ? <ProjectDiscussionCenter boardId={boardId} />
      : tab === 'knowledge'
        ? <KnowledgeView boardId={boardId} />
        : <TeamPlanningBoard boardId={boardId} />}
  </main>
}

function TeamPlanningBoard({ boardId }: { boardId: number }) {
  const [data, setData] = useState<TeamPlanningVisualizationData | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    setError(null)
    api('GET', `/os/boards/${boardId}/team-visualization`)
      .then((value: TeamPlanningVisualizationData) => { if (active) setData(value) }, (reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : 'Team plan could not load.')
    })
    return () => { active = false }
  }, [boardId])
  return <TeamPlanningVisualization data={data} loading={!data && !error} error={error} />
}
