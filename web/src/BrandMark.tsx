import React from 'react'

export function OrchestraMark({ className = 'mark', label }: {
  className?: string
  label?: string
}) {
  return (
    <img
      className={className}
      src="/icons/orchestra-mark.svg"
      alt={label ?? ''}
      aria-hidden={label ? undefined : true}
    />
  )
}
