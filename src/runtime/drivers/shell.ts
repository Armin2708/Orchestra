import os from 'node:os'
import type { RuntimeSupervisor } from '../supervisor.js'
import type {
  AgentDriver,
  DriverCapabilities,
  DriverEvent,
  DriverLaunchRequest,
  DriverSession,
  DriverSessionStatus,
  OsId,
  ProcessRecord,
} from '../types.js'

const processStatus = (record: ProcessRecord): DriverSessionStatus => {
  switch (record.status) {
    case 'starting': return 'starting'
    case 'running': return 'running'
    case 'stopping': return 'stopping'
    case 'lost': return 'lost'
    case 'failed': return 'failed'
    default: return 'stopped'
  }
}

export class ShellAgentDriver implements AgentDriver {
  readonly id = 'shell'
  private readonly sessions = new Map<string, OsId>()

  constructor(private readonly runtime: RuntimeSupervisor) {}

  capabilities(): DriverCapabilities {
    return { attach: true, streaming: true, interrupt: true, stop: true, rawTerminal: true, resume: false }
  }

  async launch(request: DriverLaunchRequest): Promise<DriverSession> {
    const command = request.command?.trim()
    const shell = process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : process.env.SHELL || '/bin/sh'
    const direct = command !== undefined && request.args !== undefined
    const record = await this.runtime.spawn(command ? {
      workspaceId: request.workspaceId,
      name: request.name || command,
      command,
      cwd: request.cwd,
      env: request.env,
      ...(direct ? { args: request.args } : {}),
      shell: !direct,
      restartable: true,
    } : {
      workspaceId: request.workspaceId,
      name: request.name || `${os.userInfo().username} shell`,
      command: shell,
      args: request.args ?? [],
      cwd: request.cwd,
      env: request.env,
      shell: false,
      restartable: true,
    })
    const session = this.session(record)
    this.sessions.set(session.id, record.id)
    if (request.prompt) await this.runtime.write(record.id, request.prompt, 'driver')
    return session
  }

  async attach(externalId: string): Promise<DriverSession | null> {
    const record = await this.runtime.get(externalId)
    if (!record) return null
    const session = this.session(record)
    this.sessions.set(session.id, record.id)
    return session
  }

  async send(sessionId: string, text: string): Promise<void> {
    await this.runtime.write(this.processId(sessionId), text, 'driver')
  }

  async interrupt(sessionId: string): Promise<void> {
    await this.runtime.signal(this.processId(sessionId), 'SIGINT')
  }

  async stop(sessionId: string): Promise<void> {
    await this.runtime.stop(this.processId(sessionId))
  }

  async *events(sessionId: string): AsyncIterable<DriverEvent> {
    const processId = this.processId(sessionId)
    let seq = 0
    for await (const item of this.runtime.events(processId)) {
      if (item.type === 'output') {
        yield {
          sessionId,
          seq: ++seq,
          type: 'output',
          at: item.output.createdAt,
          data: item.output.data,
          metadata: { outputSeq: item.output.seq, stream: item.output.stream },
        }
        continue
      }
      const terminal = ['process.exited', 'process.failed', 'process.stopped', 'process.lost'].includes(item.event.kind)
      yield {
        sessionId,
        seq: ++seq,
        type: terminal ? 'exit' : item.event.kind === 'process.failed' ? 'error' : 'status',
        at: item.event.at,
        data: item.event.kind,
        metadata: item.event.payload,
      }
    }
  }

  private session(record: ProcessRecord): DriverSession {
    return {
      id: `${this.id}:${record.id}`,
      externalId: record.id,
      driverId: this.id,
      workspaceId: record.workspaceId,
      status: processStatus(record),
      startedAt: record.startedAt ?? new Date().toISOString(),
      metadata: {
        processId: record.id,
        pid: record.pid,
        cwd: record.cwd,
        command: record.command,
        cols: record.cols,
        rows: record.rows,
      },
    }
  }

  private processId(sessionId: string): OsId {
    const id = this.sessions.get(sessionId)
    if (!id) throw new Error(`shell session not attached: ${sessionId}`)
    return id
  }
}
