import React from 'react'

// What remains here is the pane shell the Trackbook still uses. The cockpit panes
// (conversation, changes, evidence, context, policy, processes) went with
// WorkspaceCockpit when the board's workspace surface became a plain terminal (#162).

export type Resource<T> = {
  status: 'idle' | 'loading' | 'ready' | 'error'
  data: T
  error: string | null
}

export const resource = <T,>(data: T): Resource<T> => ({ status: 'idle', data, error: null })

export function PaneFrame({ title, eyebrow, action, children }: {
  title: string
  eyebrow?: string
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="os-pane-frame">
      <header className="os-pane-head">
        <div>
          {eyebrow && <p className="os-eyebrow">{eyebrow}</p>}
          <h3>{title}</h3>
        </div>
        {action}
      </header>
      <div className="os-pane-body">{children}</div>
    </section>
  )
}

export function PaneSkeleton() {
  return (
    <div className="os-pane-skeleton" aria-label="Loading pane">
      <i className="wide" /><i /><i className="short" /><i className="wide" /><i />
    </div>
  )
}
