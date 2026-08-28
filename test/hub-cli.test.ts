import { describe, it, expect, vi, afterEach } from 'vitest'
import { Command } from 'commander'
import { registerHubCommands } from '../src/hub-cli.js'

// These mocks stand in for defaultStartHub's own dynamic imports (./hub/env.js,
// ./hub/pg.js, ./hub/migrations.js, ./hub/server.js). Only the last test below
// (which omits `startHub`, exercising the real defaultStartHub) ever touches
// them; the two tests above always inject their own `startHub` and never reach
// these modules. vi.mock applies to dynamic `import()` calls the same as
// static ones — see hub-pg.test.ts for the same pattern against 'pg'.
vi.mock('../src/hub/env.js', () => ({
  hubEnv: vi.fn(() => ({
    databaseUrl: 'postgres://example/hub',
    port: 4760,
    webOrigin: 'https://app.example.com',
    clerkSecretKey: 'sk_test_from_hubenv',
  })),
}))
vi.mock('../src/hub/pg.js', () => ({
  createPgPool: vi.fn(() => ({ query: vi.fn(async () => ({ rows: [], rowCount: 0 })) })),
}))
vi.mock('../src/hub/migrations.js', () => ({
  hubMigrate: vi.fn(async () => []),
}))
vi.mock('../src/hub/server.js', () => ({
  buildHubServer: vi.fn(() => ({ listen: vi.fn(async () => {}) })),
}))

afterEach(() => {
  vi.clearAllMocks()
})

describe('orchestra hub command', () => {
  it('starts the hub on the configured port and database', async () => {
    const started: any[] = []
    const program = new Command()
    program.exitOverride()
    registerHubCommands(program, {
      startHub: async (opts) => { started.push(opts) },
      output: () => {},
      env: { HUB_DATABASE_URL: 'postgres://example/hub' },
    })

    await program.parseAsync(['node', 'orchestra', 'hub', '--port', '5150'])

    expect(started).toEqual([{ port: 5150, databaseUrl: 'postgres://example/hub' }])
  })

  it('fails clearly when no database URL is configured', async () => {
    const lines: string[] = []
    const program = new Command()
    program.exitOverride()
    registerHubCommands(program, {
      startHub: async () => { throw new Error('should not start') },
      output: (line) => lines.push(line),
      env: {},
    })

    await expect(program.parseAsync(['node', 'orchestra', 'hub'])).rejects.toThrow(/DATABASE_URL/i)
  })
})

describe('orchestra hub command: default start path (no injected startHub)', () => {
  it('threads webOrigin and clerkSecretKey from hubEnv() into buildHubServer', async () => {
    const { buildHubServer } = await import('../src/hub/server.js')

    const program = new Command()
    program.exitOverride()
    registerHubCommands(program, {
      // No `startHub` override: this exercises the real defaultStartHub.
      output: () => {},
      env: { HUB_DATABASE_URL: 'postgres://example/hub' },
    })

    await program.parseAsync(['node', 'orchestra', 'hub'])

    expect(buildHubServer).toHaveBeenCalledWith(
      expect.anything(),
      { webOrigin: 'https://app.example.com', clerkSecretKey: 'sk_test_from_hubenv' },
    )
  })
})
