import { describe, it, expect } from 'vitest'
import { Command } from 'commander'
import { registerHubCommands } from '../src/hub-cli.js'

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
