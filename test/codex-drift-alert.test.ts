import { describe, expect, it } from 'vitest'
import { openDb } from '../src/db.js'
import { CodexProviderService } from '../src/codex/provider-service.js'
import { checkCodexDriftAndAlert } from '../src/codex/drift-alert.js'
import type { CodexSupervisorLifecycleEvent, CodexSupervisorState } from '../src/codex/supervisor.js'

class FakeSupervisor {
  state: CodexSupervisorState = 'idle'
  private readonly listeners = new Set<(event: CodexSupervisorLifecycleEvent) => void>()

  async start(): Promise<void> {
    this.state = 'running'
    const event: CodexSupervisorLifecycleEvent = {
      type: 'connected', state: 'running', at: new Date().toISOString(), generation: 1, attempt: 0,
    }
    for (const listener of this.listeners) listener(event)
  }

  onLifecycle(listener: (event: CodexSupervisorLifecycleEvent) => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

const authenticatedRpc = () => ({
  listModels: async () => [],
  readAccount: async () => ({ account: { type: 'apiKey' }, requiresOpenaiAuth: true }),
  readRateLimits: async () => ({}) as any,
  readUsage: async () => ({}) as any,
})

const insertBoard = (db: ReturnType<typeof openDb>, projectPath: string): number =>
  Number(db.prepare(`INSERT INTO boards (project_path, name) VALUES (?, ?)`)
    .run(projectPath, projectPath).lastInsertRowid)

describe('checkCodexDriftAndAlert', () => {
  it('mails every board once when the CLI drifts off the pin, then stays quiet', async () => {
    const db = openDb(':memory:')
    const b1 = insertBoard(db, '/p1')
    const b2 = insertBoard(db, '/p2')
    let probed = 'codex-cli 0.146.0'
    const service = new CodexProviderService(db, authenticatedRpc(), new FakeSupervisor(), {
      version: 'codex-cli 0.146.0',
      versionProbe: () => probed,
    })
    await service.initialize()

    probed = 'codex-cli 0.150.0'
    expect(await checkCodexDriftAndAlert(db, service)).toBe(true)

    // Orchestra keeps running on the unverified version — this is a heads-up, not
    // a blocker, so the mail is fyi rather than the old hard-stop framing.
    const mail = db.prepare(`SELECT board_id, mail_type, subject, to_human FROM messages ORDER BY board_id`).all() as any[]
    expect(mail.map((m) => m.board_id)).toEqual([b1, b2])
    expect(mail[0]).toMatchObject({ mail_type: 'fyi', subject: 'Codex CLI drifted off the pin', to_human: 1 })
    expect(service.isRuntimeAvailable()).toBe(true)

    // Edge-triggered: a second tick after the same drift must not mail again.
    expect(await checkCodexDriftAndAlert(db, service)).toBe(false)
    const count = db.prepare(`SELECT COUNT(*) as n FROM messages`).get() as any
    expect(count.n).toBe(2)
  })

  it('does nothing when the CLI still matches the pin', async () => {
    const db = openDb(':memory:')
    insertBoard(db, '/p')
    const service = new CodexProviderService(db, authenticatedRpc(), new FakeSupervisor(), {
      version: 'codex-cli 0.146.0',
      versionProbe: () => 'codex-cli 0.146.0',
    })
    await service.initialize()

    expect(await checkCodexDriftAndAlert(db, service)).toBe(false)
    const count = db.prepare(`SELECT COUNT(*) as n FROM messages`).get() as any
    expect(count.n).toBe(0)
  })
})
