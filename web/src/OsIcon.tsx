import React from 'react'

export type OsIconName =
  | 'archive' | 'attention' | 'bell' | 'branch' | 'check' | 'chevron' | 'close'
  | 'command' | 'context' | 'diff' | 'evidence' | 'external' | 'folder' | 'message'
  | 'plus' | 'policy' | 'process' | 'refresh' | 'search' | 'send' | 'terminal' | 'workspace'

export function OsIcon({ name, size = 16, className }: { name: OsIconName; size?: number; className?: string }) {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.7,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    className,
    'aria-hidden': true,
  }

  const paths: Record<OsIconName, React.ReactNode> = {
    archive: <><path d="M4 7.5h16v12H4z"/><path d="M3 4.5h18v3H3zM9 11h6"/></>,
    attention: <><path d="M12 3 2.8 19h18.4L12 3Z"/><path d="M12 9v4.5M12 17h.01"/></>,
    bell: <><path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4"/></>,
    branch: <><circle cx="6" cy="5" r="2"/><circle cx="18" cy="6" r="2"/><circle cx="6" cy="19" r="2"/><path d="M6 7v10M8 12h3c4 0 7-2 7-4"/></>,
    check: <path d="m5 12.5 4.2 4.2L19 7"/>,
    chevron: <path d="m9 6 6 6-6 6"/>,
    close: <path d="m6 6 12 12M18 6 6 18"/>,
    command: <><path d="M9 6V5a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v14a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6Z"/></>,
    context: <><path d="M5 4h11a3 3 0 0 1 3 3v13H7a2 2 0 0 1-2-2V4Z"/><path d="M7 16h12M9 8h6M9 11h5"/></>,
    diff: <><circle cx="7" cy="5" r="2"/><circle cx="7" cy="19" r="2"/><circle cx="17" cy="9" r="2"/><path d="M7 7v10M9 14c5 0 8-1 8-3"/></>,
    evidence: <><path d="M6 3h9l3 3v15H6z"/><path d="M14 3v4h4M9 12l2 2 4-5"/></>,
    external: <><path d="M14 4h6v6M20 4l-9 9"/><path d="M18 13v6H5V6h6"/></>,
    folder: <path d="M3 6h7l2 2h9v11H3z"/>,
    message: <path d="M4 5h16v12H9l-5 4V5Z"/>,
    plus: <path d="M12 5v14M5 12h14"/>,
    policy: <><path d="M12 3 5 6v5c0 4.6 2.8 8 7 10 4.2-2 7-5.4 7-10V6l-7-3Z"/><path d="m9 12 2 2 4-5"/></>,
    process: <><path d="M5 5h14v14H5z"/><path d="m8 9 3 3-3 3M13 15h3"/></>,
    refresh: <><path d="M20 7v5h-5"/><path d="M19 12a7 7 0 1 0-1.7 4.6"/></>,
    search: <><circle cx="11" cy="11" r="6"/><path d="m16 16 4 4"/></>,
    send: <><path d="m3 11 18-8-8 18-2-8-8-2Z"/><path d="m11 13 5-5"/></>,
    terminal: <><path d="M4 5h16v14H4z"/><path d="m7 9 3 3-3 3M12 15h4"/></>,
    workspace: <><path d="M4 4h16v16H4z"/><path d="M4 9h16M9 9v11"/></>,
  }

  return <svg {...common}>{paths[name]}</svg>
}
