import { spawn } from 'node:child_process'
import type { SpawnOptions } from 'node:child_process'
import { Buffer } from 'node:buffer'
import { deferred, type Deferred } from './async.js'
import { isRecord } from './protocol.js'

export type CodexTransportClose = {
  code: number | null
  signal: string | null
  expected: boolean
}
export type CodexTransportListener<T> = (value: T) => void
export type CodexUnsubscribe = () => void

export interface CodexByteTransport {
  readonly closed: boolean
  write(data: string): Promise<void>
  close(): Promise<void>
  onData(listener: CodexTransportListener<Uint8Array>): CodexUnsubscribe
  onStderr(listener: CodexTransportListener<string>): CodexUnsubscribe
  onError(listener: CodexTransportListener<Error>): CodexUnsubscribe
  onClose(listener: CodexTransportListener<CodexTransportClose>): CodexUnsubscribe
}

export class CodexFrameTooLargeError extends Error {
  constructor(readonly size: number, readonly limit: number) {
    super(`Codex app-server JSONL frame is ${size} bytes; limit is ${limit}`)
    this.name = 'CodexFrameTooLargeError'
  }
}

export class CodexInvalidFrameError extends Error {
  constructor(message: string, readonly frame?: string) {
    super(message)
    this.name = 'CodexInvalidFrameError'
  }
}

export class CodexJsonlDecoder {
  private buffer = Buffer.alloc(0)

  constructor(readonly maxFrameBytes = 8 * 1024 * 1024) {
    if (!Number.isInteger(maxFrameBytes) || maxFrameBytes < 1) {
      throw new Error('maxFrameBytes must be a positive integer')
    }
  }

  push(chunk: Uint8Array): Record<string, unknown>[] {
    if (chunk.byteLength === 0) return []
    this.buffer = this.buffer.length === 0
      ? Buffer.from(chunk)
      : Buffer.concat([this.buffer, Buffer.from(chunk)], this.buffer.length + chunk.byteLength)
    const messages: Record<string, unknown>[] = []
    let newline = this.buffer.indexOf(0x0a)
    while (newline >= 0) {
      if (newline > this.maxFrameBytes) throw new CodexFrameTooLargeError(newline, this.maxFrameBytes)
      const raw = this.buffer.subarray(0, newline)
      this.buffer = this.buffer.subarray(newline + 1)
      const frame = raw.length > 0 && raw[raw.length - 1] === 0x0d ? raw.subarray(0, raw.length - 1) : raw
      if (frame.length > 0) messages.push(this.parse(frame))
      newline = this.buffer.indexOf(0x0a)
    }
    if (this.buffer.length > this.maxFrameBytes) {
      throw new CodexFrameTooLargeError(this.buffer.length, this.maxFrameBytes)
    }
    return messages
  }

  finish(): Record<string, unknown>[] {
    if (this.buffer.length === 0) return []
    if (this.buffer.length > this.maxFrameBytes) {
      throw new CodexFrameTooLargeError(this.buffer.length, this.maxFrameBytes)
    }
    const frame = this.buffer
    this.buffer = Buffer.alloc(0)
    return frame.every((byte) => byte === 0x20 || byte === 0x09 || byte === 0x0d)
      ? []
      : [this.parse(frame)]
  }

  private parse(frame: Uint8Array): Record<string, unknown> {
    const text = Buffer.from(frame).toString('utf8')
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new CodexInvalidFrameError(`Invalid Codex app-server JSONL frame: ${detail}`, text.slice(0, 512))
    }
    if (!isRecord(value)) throw new CodexInvalidFrameError('Codex app-server frame must be a JSON object', text.slice(0, 512))
    return value
  }
}

export interface CodexChildReadable {
  on(event: 'data', listener: (chunk: Uint8Array | string) => void): unknown
}

export interface CodexChildWritable {
  readonly writable: boolean
  write(data: string, callback?: (error?: Error | null) => void): boolean
  end(): void
}

export interface CodexChildProcess {
  readonly pid?: number
  readonly stdin: CodexChildWritable
  readonly stdout: CodexChildReadable
  readonly stderr: CodexChildReadable
  once(event: 'error', listener: (error: Error) => void): unknown
  once(event: 'close', listener: (code: number | null, signal: string | null) => void): unknown
  kill(signal?: NodeJS.Signals): boolean
}

export type CodexProcessSpawner = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => CodexChildProcess

export type CodexProcessTransportOptions = {
  command?: string
  args?: string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
  gracefulShutdownMs?: number
  terminateWaitMs?: number
  maxStderrLineBytes?: number
  spawnProcess?: CodexProcessSpawner
}

export class CodexProcessTransport implements CodexByteTransport {
  private readonly dataListeners = new Set<CodexTransportListener<Uint8Array>>()
  private readonly stderrListeners = new Set<CodexTransportListener<string>>()
  private readonly errorListeners = new Set<CodexTransportListener<Error>>()
  private readonly closeListeners = new Set<CodexTransportListener<CodexTransportClose>>()
  private readonly exited: Deferred<CodexTransportClose> = deferred()
  private stderrBuffer = ''
  private closing = false
  private didClose = false

  private constructor(
    private readonly child: CodexChildProcess,
    private readonly options: Required<Pick<CodexProcessTransportOptions,
      'gracefulShutdownMs' | 'terminateWaitMs' | 'maxStderrLineBytes'>>,
  ) {
    child.stdout.on('data', (chunk) => {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      this.emit(this.dataListeners, bytes)
    })
    child.stderr.on('data', (chunk) => this.acceptStderr(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')))
    child.once('error', (error) => this.emit(this.errorListeners, error))
    child.once('close', (code, signal) => this.finishClose({ code, signal, expected: this.closing }))
  }

  static spawn(options: CodexProcessTransportOptions = {}): CodexProcessTransport {
    const command = options.command ?? 'codex'
    const args = options.args ?? ['app-server', '--listen', 'stdio://']
    const spawnProcess = options.spawnProcess ?? ((cmd, argv, spawnOptions) =>
      spawn(cmd, argv, spawnOptions) as unknown as CodexChildProcess)
    const child = spawnProcess(command, args, {
      cwd: options.cwd,
      env: options.env ? { ...process.env, ...options.env } : process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    return new CodexProcessTransport(child, {
      gracefulShutdownMs: Math.max(0, options.gracefulShutdownMs ?? 1_000),
      terminateWaitMs: Math.max(0, options.terminateWaitMs ?? 1_000),
      maxStderrLineBytes: Math.max(1_024, options.maxStderrLineBytes ?? 64 * 1024),
    })
  }

  get closed(): boolean {
    return this.didClose
  }

  async write(data: string): Promise<void> {
    if (this.didClose || this.closing || !this.child.stdin.writable) {
      throw new Error('Codex app-server stdin is closed')
    }
    await new Promise<void>((resolve, reject) => {
      this.child.stdin.write(data, (error) => error ? reject(error) : resolve())
    })
  }

  async close(): Promise<void> {
    if (this.didClose) return
    if (!this.closing) {
      this.closing = true
      try { this.child.stdin.end() } catch {}
    }
    if (await this.waitForExit(this.options.gracefulShutdownMs)) return
    try { this.child.kill('SIGTERM') } catch {}
    if (await this.waitForExit(this.options.terminateWaitMs)) return
    try { this.child.kill('SIGKILL') } catch {}
    await this.waitForExit(this.options.terminateWaitMs)
  }

  onData(listener: CodexTransportListener<Uint8Array>): CodexUnsubscribe {
    return this.add(this.dataListeners, listener)
  }

  onStderr(listener: CodexTransportListener<string>): CodexUnsubscribe {
    return this.add(this.stderrListeners, listener)
  }

  onError(listener: CodexTransportListener<Error>): CodexUnsubscribe {
    return this.add(this.errorListeners, listener)
  }

  onClose(listener: CodexTransportListener<CodexTransportClose>): CodexUnsubscribe {
    if (this.didClose) void this.exited.promise.then(listener)
    else this.closeListeners.add(listener)
    return () => this.closeListeners.delete(listener)
  }

  private acceptStderr(text: string): void {
    this.stderrBuffer += text
    let newline = this.stderrBuffer.indexOf('\n')
    while (newline >= 0) {
      this.emitStderrLine(this.stderrBuffer.slice(0, newline).replace(/\r$/, ''))
      this.stderrBuffer = this.stderrBuffer.slice(newline + 1)
      newline = this.stderrBuffer.indexOf('\n')
    }
    if (Buffer.byteLength(this.stderrBuffer) > this.options.maxStderrLineBytes) {
      this.emitStderrLine(`${this.stderrBuffer.slice(0, this.options.maxStderrLineBytes)}… [truncated]`)
      this.stderrBuffer = ''
    }
  }

  private emitStderrLine(line: string): void {
    if (line.length > 0) this.emit(this.stderrListeners, line)
  }

  private finishClose(close: CodexTransportClose): void {
    if (this.didClose) return
    this.didClose = true
    if (this.stderrBuffer.length > 0) this.emitStderrLine(this.stderrBuffer)
    this.stderrBuffer = ''
    this.exited.resolve(close)
    this.emit(this.closeListeners, close)
    this.dataListeners.clear()
    this.stderrListeners.clear()
    this.errorListeners.clear()
    this.closeListeners.clear()
  }

  private async waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.didClose) return true
    if (timeoutMs <= 0) return false
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs)
      timer.unref?.()
      void this.exited.promise.then(() => {
        clearTimeout(timer)
        resolve(true)
      })
    })
  }

  private add<T>(listeners: Set<CodexTransportListener<T>>, listener: CodexTransportListener<T>): CodexUnsubscribe {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  private emit<T>(listeners: Set<CodexTransportListener<T>>, value: T): void {
    for (const listener of [...listeners]) listener(value)
  }
}
