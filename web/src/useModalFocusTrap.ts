import { RefObject, useEffect } from 'react'

const focusableSelector = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

/** Keep keyboard focus inside a modal and restore the invoking control on close. */
export function useModalFocusTrap(
  active: boolean,
  containerRef: RefObject<HTMLElement | null>,
  onClose: () => void,
  initialRef?: RefObject<HTMLElement | null>,
) {
  useEffect(() => {
    if (!active) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const focusable = () => [...(containerRef.current?.querySelectorAll<HTMLElement>(focusableSelector) ?? [])]
      .filter((element) => element.offsetParent !== null && element.getAttribute('aria-hidden') !== 'true')
    const frame = window.requestAnimationFrame(() => {
      const first = initialRef?.current ?? focusable()[0] ?? containerRef.current
      first?.focus()
    })
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key !== 'Tab') return
      const elements = focusable()
      if (elements.length === 0) {
        event.preventDefault()
        containerRef.current?.focus()
        return
      }
      const first = elements[0]
      const last = elements[elements.length - 1]
      const current = document.activeElement
      if (event.shiftKey && (current === first || !containerRef.current?.contains(current))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (current === last || !containerRef.current?.contains(current))) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.cancelAnimationFrame(frame)
      document.removeEventListener('keydown', onKeyDown, true)
      window.requestAnimationFrame(() => previous?.focus())
    }
  }, [active, containerRef, initialRef, onClose])
}
