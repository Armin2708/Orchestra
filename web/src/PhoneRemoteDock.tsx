import React from 'react'
import type { BoardTab } from './boardNavigation'
import { useRemoteAccess } from './RemoteAccess'

export function PhoneRemoteDock({ active, onTab, onAttention }: {
  active: BoardTab
  onTab: (tab: BoardTab) => void
  onAttention: () => void
}) {
  const access = useRemoteAccess()
  return (
    <nav className="phone-remote-dock" aria-label="Phone remote controls">
      <button type="button" className={active === 'overview' ? 'active' : ''} onClick={() => onTab('overview')}>
        <span aria-hidden="true">◎</span><strong>Monitor</strong>
      </button>
      <button type="button" className={active === 'messages' ? 'active' : ''} onClick={() => onTab('messages')}
        disabled={!access.online}>
        <span aria-hidden="true">◌</span><strong>Message</strong>
      </button>
      <button type="button" onClick={onAttention} disabled={!access.online}>
        <span aria-hidden="true">◇</span><strong>Approve</strong>
      </button>
      <button type="button" className={active === 'agents' ? 'active' : ''} onClick={() => onTab('agents')}>
        <span aria-hidden="true">Ⅱ</span><strong>Pause / stop</strong>
      </button>
    </nav>
  )
}
