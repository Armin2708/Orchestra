import React, { forwardRef, useEffect, useId, useImperativeHandle, useRef, useState } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { OsId, osApi, WorkspaceProcess } from './osApi'
import { OsIcon } from './OsIcon'
import { isResizableProcess } from './processTerminalState'
import { runRuntimeMutation } from './runtimeReadOnly'
import { RemoteControlGate, useRemoteAccess } from './RemoteAccess'

export type ProcessTerminalHandle = { focus: () => void; fit: () => void }

export type TerminalFocusDirection = 'forward' | 'backward'

export function routeTerminalKeyEvent(
  event: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'type' | 'preventDefault' | 'stopPropagation'>,
  escapeArmed: boolean,
  setEscapeArmed: (armed: boolean) => void,
  moveFocus: (direction: TerminalFocusDirection) => boolean,
): boolean {
  if (event.type !== 'keydown') return true
  if (event.key === 'Escape') {
    setEscapeArmed(true)
    return true
  }
  if (event.key === 'Tab' && escapeArmed) {
    setEscapeArmed(false)
    if (moveFocus(event.shiftKey ? 'backward' : 'forward')) {
      event.preventDefault()
      event.stopPropagation()
    }
    return false
  }
  if (!['Alt', 'Control', 'Meta', 'Shift'].includes(event.key)) setEscapeArmed(false)
  return true
}

export const ProcessTerminal = forwardRef<ProcessTerminalHandle, {
  process: WorkspaceProcess | null
  readOnly?: boolean
  onProcessChanged?: () => void
}>(({ process, readOnly = false, onProcessChanged }, forwardedRef) => {
  const remoteAccess = useRemoteAccess()
  const remoteWritable = Boolean(process && remoteAccess.canUse('terminal-write', 'process', String(process.id)))
  const writable = !readOnly && remoteWritable
  const hostRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const processRef = useRef<WorkspaceProcess | null>(process)
  const readOnlyRef = useRef(readOnly)
  const sequenceRef = useRef(0)
  const inputQueueRef = useRef<Promise<unknown>>(Promise.resolve())
  const inputBufferRef = useRef<{ processId: OsId; data: string } | null>(null)
  const inputTimerRef = useRef<number | undefined>()
  const flushInputRef = useRef<(() => void) | null>(null)
  const resizeTimerRef = useRef<number | undefined>()
  const writableRef = useRef(writable)
  const [streamError, setStreamError] = useState<string | null>(null)
  const escapeArmedRef = useRef(false)
  const [escapeArmed, setEscapeArmedState] = useState(false)
  const keyboardHelpId = useId()

  processRef.current = process
  readOnlyRef.current = readOnly
  writableRef.current = writable

  useImperativeHandle(forwardedRef, () => ({
    focus: () => terminalRef.current?.focus(),
    fit: () => {
      try { fitRef.current?.fit() } catch { /* hidden panes cannot be measured */ }
    },
  }), [])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const terminal = new Terminal({
      allowProposedApi: false,
      disableStdin: !writableRef.current,
      convertEol: false,
      cursorBlink: true,
      cursorStyle: 'block',
      drawBoldTextInBrightColors: false,
      fontFamily: "'SF Mono', 'JetBrains Mono', ui-monospace, monospace",
      fontSize: 12.5,
      fontWeight: 400,
      fontWeightBold: 600,
      letterSpacing: 0,
      lineHeight: 1.35,
      scrollback: 10_000,
      screenReaderMode: true,
      theme: {
        background: '#201f1c',
        foreground: '#e6e1d8',
        cursor: '#d97757',
        cursorAccent: '#201f1c',
        selectionBackground: '#5f5549',
        selectionForeground: '#ffffff',
        black: '#2b2925',
        red: '#d16b64',
        green: '#88a66f',
        yellow: '#c8a765',
        blue: '#8297ad',
        magenta: '#a98aa0',
        cyan: '#78a5a0',
        white: '#ded9d1',
        brightBlack: '#777168',
        brightRed: '#e3847b',
        brightGreen: '#a7bf8d',
        brightYellow: '#d8bc7a',
        brightBlue: '#9baec0',
        brightMagenta: '#bea1b5',
        brightCyan: '#91bbb6',
        brightWhite: '#f7f4ee',
      },
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    const setEscapeArmed = (armed: boolean) => {
      escapeArmedRef.current = armed
      setEscapeArmedState(armed)
    }
    const moveFocus = (direction: TerminalFocusDirection) => {
      const current = terminal.textarea
      if (!current) return false
      const focusable = [...document.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )].filter((element) => element.getClientRects().length > 0
        && element.getAttribute('aria-hidden') !== 'true')
      const index = focusable.indexOf(current)
      const target = index < 0 ? undefined : focusable[index + (direction === 'forward' ? 1 : -1)]
      if (!target) return false
      target.focus()
      return document.activeElement === target
    }
    terminal.attachCustomKeyEventHandler((event) => routeTerminalKeyEvent(
      event,
      escapeArmedRef.current,
      setEscapeArmed,
      moveFocus,
    ))
    terminal.open(host)
    terminalRef.current = terminal
    fitRef.current = fit

    const sendResize = () => {
      if (readOnlyRef.current) return
      try { fit.fit() } catch { return }
      const active = processRef.current
      if (!writableRef.current || !isResizableProcess(active)) return
      const processId = active.id
      if (resizeTimerRef.current) window.clearTimeout(resizeTimerRef.current)
      resizeTimerRef.current = window.setTimeout(() => {
        const current = processRef.current
        if (!isResizableProcess(current) || String(current.id) !== String(processId)) return
        osApi.resizeProcess(current.id, terminal.cols, terminal.rows).catch(() => {})
      }, 120)
    }
    const frame = window.requestAnimationFrame(sendResize)
    const observer = new ResizeObserver(sendResize)
    observer.observe(host)

    const flushInput = () => {
      if (inputTimerRef.current) window.clearTimeout(inputTimerRef.current)
      inputTimerRef.current = undefined
      const batch = inputBufferRef.current
      inputBufferRef.current = null
      if (!batch?.data || readOnlyRef.current) return
      inputQueueRef.current = inputQueueRef.current
        .catch(() => undefined)
        .then(() => runRuntimeMutation(readOnlyRef.current,
          () => osApi.writeProcessInput(batch.processId, batch.data)))
        .catch(() => setStreamError('Terminal input could not reach the process.'))
    }
    flushInputRef.current = flushInput

    // pasting an image can't ride the PTY byte stream the way text does: upload it,
    // then type the saved file's path into the prompt — Claude/Codex CLIs attach
    // image paths from the prompt exactly like their native terminal paste.
    const PASTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
    const onPasteImage = (event: ClipboardEvent) => {
      const item = [...(event.clipboardData?.items ?? [])]
        .find((entry) => PASTED_IMAGE_TYPES.includes(entry.type))
      if (!item) return // plain text paste — xterm's own handler owns it
      event.preventDefault()
      event.stopPropagation()
      if (readOnlyRef.current) return
      const active = processRef.current
      if (!writableRef.current || !active || !['running', 'starting', 'stopping'].includes(active.status)) return
      const file = item.getAsFile()
      if (!file) return
      const processId = active.id
      void file.arrayBuffer().then((buffer) => {
        let binary = ''
        const bytes = new Uint8Array(buffer)
        for (let i = 0; i < bytes.length; i += 0x8000)
          binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
        return runRuntimeMutation(readOnlyRef.current, async () => {
          const saved = await osApi.pasteProcessImage(processId, item.type, btoa(binary))
          await osApi.writeProcessInput(processId, `${saved.path} `)
        })
      }).catch(() => setStreamError('Pasted image could not reach the process.'))
    }
    host.addEventListener('paste', onPasteImage, true)

    const input = terminal.onData((data) => {
      if (readOnlyRef.current) return
      const active = processRef.current
      if (!writableRef.current || !active || !['running', 'starting', 'stopping'].includes(active.status)) return
      const current = inputBufferRef.current
      if (current && String(current.processId) !== String(active.id)) flushInput()
      const next = inputBufferRef.current
      inputBufferRef.current = next
        ? { processId: next.processId, data: next.data + data }
        : { processId: active.id, data }
      if (!inputTimerRef.current) inputTimerRef.current = window.setTimeout(flushInput, 12)
    })

    return () => {
      window.cancelAnimationFrame(frame)
      if (resizeTimerRef.current) window.clearTimeout(resizeTimerRef.current)
      flushInput()
      flushInputRef.current = null
      observer.disconnect()
      host.removeEventListener('paste', onPasteImage, true)
      input.dispose()
      terminal.dispose()
      terminalRef.current = null
      fitRef.current = null
    }
  }, [])

  useEffect(() => {
    if (terminalRef.current) terminalRef.current.options.disableStdin = !writable
    if (!writable) {
      inputBufferRef.current = null
      if (inputTimerRef.current) window.clearTimeout(inputTimerRef.current)
      inputTimerRef.current = undefined
    }
  }, [readOnly, writable])

  useEffect(() => {
    flushInputRef.current?.()
    sequenceRef.current = 0
    setStreamError(null)
    const terminal = terminalRef.current
    if (!terminal) return
    terminal.reset()
    terminal.clear()
    let frame: number | undefined
    if (writableRef.current && isResizableProcess(process)) {
      frame = window.requestAnimationFrame(() => {
        try { fitRef.current?.fit() } catch { return }
        const current = processRef.current
        if (!isResizableProcess(current) || String(current.id) !== String(process.id)) return
        osApi.resizeProcess(current.id, terminal.cols, terminal.rows).catch(() => {})
      })
    }
    return () => { if (frame) window.cancelAnimationFrame(frame) }
  }, [process?.id, readOnly, writable])

  useEffect(() => {
    if (!process) return
    let alive = true
    let pending = false
    let refreshClock = 0
    let timer: number | undefined

    const schedule = (delay: number) => {
      if (alive) timer = window.setTimeout(read, delay)
    }

    // A live process is read with a long poll: the daemon holds the request until the pty
    // writes, so output (including the echo of what you just typed) comes back at network
    // latency rather than on a fixed interval, and an idle terminal costs one parked
    // request instead of six a second. Re-issue immediately — the wait is server-side.
    const live = ['running', 'starting', 'stopping'].includes(process.status)
    const waitMs = live ? 20_000 : 0

    const read = async () => {
      if (!alive || pending) return
      pending = true
      let nextDelay = live ? 0 : 1_500
      try {
        const { items, nextSeq } = await osApi.readProcessOutput(process.id, sequenceRef.current, waitMs)
        if (!alive) return
        for (const item of items.sort((a, b) => a.seq - b.seq)) {
          terminalRef.current?.write(item.data)
        }
        sequenceRef.current = Math.max(sequenceRef.current, nextSeq)
        setStreamError(null)
        if (items.length > 0) {
          nextDelay = 0
          refreshClock += items.length
          if (refreshClock >= 10) {
            refreshClock = 0
            onProcessChanged?.()
          }
        }
      } catch (error) {
        if (alive) setStreamError(error instanceof Error ? error.message : 'Terminal output is unavailable.')
        // a failing request must not spin: re-issuing at zero delay would hammer the daemon
        nextDelay = 1_000
      } finally {
        pending = false
        schedule(nextDelay)
      }
    }

    schedule(0)
    return () => { alive = false; if (timer) window.clearTimeout(timer) }
  }, [process?.id, process?.status, onProcessChanged])

  return (
    <div className="os-terminal-wrap">
      <div ref={hostRef} className="os-xterm" role="application"
        aria-readonly={!writable || undefined}
        aria-describedby={keyboardHelpId}
        aria-label={process ? `Terminal for ${process.name}` : 'Terminal without a process'} />
      <p id={keyboardHelpId} className={`os-terminal-keyboard-help${escapeArmed ? ' is-armed' : ''}`} aria-live="polite">
        {escapeArmed ? 'Escape armed: Tab moves focus; Shift+Tab moves backward.' : 'Tab completes in terminal. Press Escape, then Tab to leave.'}
      </p>
      {readOnly && <p className="sr-only" role="status">Terminal output is available read only while Orchestra reconnects.</p>}
      {!process && (
        <div className="os-terminal-empty" aria-hidden="true">
          <OsIcon name="terminal" size={22} />
          <strong>Start with a command</strong>
          <span>Managed PTYs keep byte-for-byte output and remain attachable with the Orchestra CLI.</span>
        </div>
      )}
      {streamError && <div className="os-terminal-error" role="alert">{streamError}</div>}
      {process && !readOnly && !remoteWritable && <RemoteControlGate scope="terminal-write" resourceType="process" resourceId={String(process.id)}
        label="Terminal output is live, but input, resize, restart, and signals require terminal-write plus a process-bound step-up." />}
    </div>
  )
})

ProcessTerminal.displayName = 'ProcessTerminal'
