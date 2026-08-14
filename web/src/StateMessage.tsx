import { OsIcon } from './OsIcon'
import './stateMessage.css'

export type StateMessageKind = 'loading' | 'empty' | 'stale' | 'offline' | 'error' | 'unsupported'

const STATE_COPY: Record<StateMessageKind, { title: string; icon: 'refresh' | 'attention' | 'search' | 'policy' }> = {
  loading: { title: 'Loading canonical records', icon: 'refresh' },
  empty: { title: 'Nothing is recorded here yet', icon: 'search' },
  stale: { title: 'Showing the last durable state', icon: 'refresh' },
  offline: { title: 'The daemon is offline', icon: 'attention' },
  error: { title: 'This surface could not load', icon: 'attention' },
  unsupported: { title: 'This capability is unavailable', icon: 'policy' },
}

export function StateMessage({
  kind,
  title,
  detail,
  action,
}: {
  kind: StateMessageKind
  title?: string
  detail: string
  action?: { label: string; onClick: () => void; disabled?: boolean }
}) {
  const copy = STATE_COPY[kind]
  const role = kind === 'error' || kind === 'offline' ? 'alert' : 'status'
  return (
    <section className={`state-message state-message-${kind}`} role={role} aria-live="polite">
      <span className="state-message-icon"><OsIcon name={copy.icon} /></span>
      <div><h2>{title ?? copy.title}</h2><p>{detail}</p></div>
      {action && <button type="button" disabled={action.disabled} onClick={action.onClick}>{action.label}</button>}
    </section>
  )
}
