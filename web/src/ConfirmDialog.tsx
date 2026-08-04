import React, { useEffect, useRef } from 'react'

/**
 * In-app confirmation — replaces window.confirm so destructive actions match
 * the UI. Enter/primary confirms, Escape/backdrop cancels, focus lands on
 * Cancel so a stray Enter never destroys anything.
 */
export function ConfirmDialog({ open, title, body, confirmLabel = 'Delete', onConfirm, onCancel }: {
  open: boolean
  title: string
  body?: string
  confirmLabel?: string
  onConfirm: () => void
  onCancel: () => void
}) {
  const cancelRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open) return
    cancelRef.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.stopPropagation(); onCancel() }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [open, onCancel])
  if (!open) return null
  return (
    <div className="confirm-backdrop" onClick={onCancel} role="presentation">
      <div className="confirm-dialog" role="alertdialog" aria-modal="true" aria-label={title}
        onClick={(event) => event.stopPropagation()}>
        <p className="confirm-title">{title}</p>
        {body && <p className="confirm-body">{body}</p>}
        <div className="confirm-actions">
          <button ref={cancelRef} type="button" className="btn ghost" onClick={onCancel}>Cancel</button>
          <button type="button" className="btn danger" onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  )
}
