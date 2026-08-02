import React, { useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { CommandCenter, TerminalTouchControls } from './CommandCenter'
import {
  CanonicalDiscussionDetail,
  CommandCenterState,
  DependencyVisualization,
  KnowledgeBrowse,
} from './CommandCenterSurfaces'
import {
  buildCommandCenterGraph,
  commandCenterStatus,
  type CommandCenterSearchRecord,
  type CommandCenterSection,
} from './commandCenterModel'
import './styles.css'

const records: CommandCenterSearchRecord[] = [
  {
    id: 'agent:runtime-operator', kind: 'agent', title: 'runtime-operator',
    description: 'Codex · managed session · Orchestra', status: 'Running', boardId: 7,
    href: '/?section=agents&agent=runtime-operator', keywords: ['codex', 'pty', 'typescript'],
  },
  {
    id: 'work:restart', kind: 'work', title: 'Daemon-to-browser continuation',
    description: 'Real restart acceptance for Agent Home', status: 'Blocked', boardId: 7,
    href: '/?section=work&job=job-restart', keywords: ['restart', 'agent home', 'pty'],
  },
  {
    id: 'delivery:runtime', kind: 'delivery', title: 'Runtime UX delivery',
    description: 'Requested versus delivered evidence', status: 'Needs review', boardId: 7,
    href: '/?section=work&delivery=delivery-runtime', keywords: ['evidence', 'review'],
  },
  {
    id: 'discussion:unsupported', kind: 'discussion', title: 'Canonical Discussion service',
    description: 'Not registered in this baseline', status: 'Unavailable', boardId: 7,
    href: '/?section=discussions', keywords: ['unsupported'],
    unavailableReason: 'Canonical Discussions are unavailable in this baseline.',
  },
  {
    id: 'knowledge:unsupported', kind: 'knowledge', title: 'Knowledge browse adapter',
    description: 'Not registered in this baseline', status: 'Unavailable', boardId: 7,
    href: '/?section=knowledge', keywords: ['unsupported'],
    unavailableReason: 'Knowledge browse is unavailable in this baseline.',
  },
]

const graph = buildCommandCenterGraph({
  graph: {
    nodes: [
      {
        card_id: 204, board_id: 7, title: 'Daemon-to-browser continuation', state: 'open',
        readiness: 'blocked', blocking_reasons: ['Managed provider session must survive daemon restart.'],
      },
      {
        card_id: 201, board_id: 7, title: 'Durable provider reattach', state: 'accepted',
        readiness: 'ready', blocking_reasons: [],
      },
      {
        card_id: 202, board_id: 7, title: 'Raw PTY continuity', state: 'running',
        readiness: 'ready', blocking_reasons: [],
      },
    ],
    edges: [
      {
        from_card_id: 204, to_card_id: 201,
        blocking_reason: 'Provider session identity must reattach exactly.',
        completion_condition: 'card_done', readiness: 'blocked',
      },
      {
        from_card_id: 204, to_card_id: 202,
        blocking_reason: 'Selected process and terminal geometry must remain durable.',
        completion_condition: 'card_done', readiness: 'ready',
      },
    ],
  },
  assignments: [{ cardId: 204, agentId: 'runtime-operator', agentName: 'runtime-operator', status: 'active' }],
  conflicts: [{
    id: 'restart-evidence', cardId: 204, otherCardId: null,
    title: 'External provider evidence pending', severity: 'high',
  }],
})

function AcceptanceApp() {
  const [section, setSection] = useState<CommandCenterSection>('work')
  const content = useMemo(() => {
    if (section === 'work') return <div className="acceptance-stack">
      <section className="acceptance-intro">
        <div><p>UI acceptance fixture · no provider support claim</p><h2>Runtime work</h2>
          <span>Real dependency records are shown below. The external provider restart gate remains blocked.</span></div>
        <span className="cc-status cc-status-warning"><span />Needs evidence</span>
      </section>
      <DependencyVisualization graph={graph} />
      <TerminalTouchControls processStatus={commandCenterStatus('process', 'running')} readOnly />
    </div>
    if (section === 'agents') return <div className="acceptance-stack">
      <section className="acceptance-intro"><div><p>Canonical surface</p><h2>Agent Home</h2>
        <span>The production Agent Home mounts here after App integration, preserving its durable chat and exact PTY split.</span></div>
        <span className="cc-status cc-status-running"><span />Running</span></section>
      <CommandCenterState kind="stale" title="Integration boundary retained"
        detail="The lane root owns App wiring. This acceptance harness does not invent an Agent Home API response." />
    </div>
    if (section === 'discussions') return <CanonicalDiscussionDetail discussion={null} posts={[]} backendAvailable={false} />
    if (section === 'knowledge') return <KnowledgeBrowse records={[]} available={false} />
    return <div className="acceptance-stack">
      <section className="acceptance-intro"><div><p>Causal history</p><h2>Activity</h2>
        <span>Events remain linked to exact work, session, process, and delivery identities.</span></div></section>
      <ol className="acceptance-activity">
        <li><time>09:42:11</time><strong>Job blocked</strong><span>External provider restart evidence is not available.</span></li>
        <li><time>09:38:04</time><strong>PTY verified</strong><span>Unicode, resize, input ordering, and exit status contracts passed.</span></li>
        <li><time>09:31:27</time><strong>Delivery submitted</strong><span>Runtime UX is waiting for independent review.</span></li>
      </ol>
    </div>
  }, [section])
  return <CommandCenter projectName="Orchestra" projectId={7} section={section}
    counts={{ work: 3, agents: 1, discussions: 0, knowledge: 0, activity: 3 }}
    searchRecords={records} currentFilters={{ gate: 'runtime-ux' }}
    onNavigate={setSection}>{content}</CommandCenter>
}

createRoot(document.getElementById('root')!).render(<AcceptanceApp />)
