import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { OsId, osApi, WorkspaceProcess } from './osApi'
import { OsIcon } from './OsIcon'
import { isResizableProcess } from './processTerminalState'
import { runRuntimeMutation } from './runtimeReadOnly'
import { RemoteControlGate, useRemoteAccess } from './RemoteAccess'

export type ProcessTerminalHandle = { focus: () => void; fit: () => void }

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
    terminal.attachCustomKeyEventHandler((event) => event.key !== 'Tab')
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

    const read = async () => {
      if (!alive || pending) return
      pending = true
      let nextDelay = ['running', 'starting', 'stopping'].includes(process.status) ? 160 : 1_500
      try {
        const { items, nextSeq } = await osApi.readProcessOutput(process.id, sequenceRef.current)
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
        aria-label={process ? `Terminal for ${process.name}` : 'Terminal without a process'} />
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
