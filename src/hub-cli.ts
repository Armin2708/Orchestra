import type { Command } from 'commander'

export interface HubCliDeps {
  startHub?: (opts: { port: number; databaseUrl: string }) => Promise<void>
  output?: (line: string) => void
  env?: NodeJS.ProcessEnv
}

/**
 * `orchestra hub` runs the hosted server. It is deliberately separate from
 * `orchestra serve` (the local daemon): different storage, different tenancy,
 * different lifecycle.
 */
export function registerHubCommands(program: Command, deps: HubCliDeps = {}): void {
  const output = deps.output ?? ((line: string) => console.log(line))
  const env = deps.env ?? process.env

  program
    .command('hub')
    .description('run the hosted multi-org hub server')
    .option('--port <port>', 'port to listen on', '4760')
    .action(async (options: { port: string }) => {
      const databaseUrl = env.HUB_DATABASE_URL ?? env.DATABASE_URL
      if (!databaseUrl) {
        throw new Error('HUB_DATABASE_URL (or DATABASE_URL) must be set to run the hub')
      }
      const port = Number(options.port)
      if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        throw new Error(`--port must be a valid port number, got ${options.port}`)
      }

      const start = deps.startHub ?? defaultStartHub
      output(`orchestra hub starting on port ${port}`)
      await start({ port, databaseUrl })
    })
}

async function defaultStartHub(opts: { port: number; databaseUrl: string }): Promise<void> {
  const { createPgPool } = await import('./hub/pg.js')
  const { hubMigrate } = await import('./hub/migrations.js')
  const { buildHubServer } = await import('./hub/server.js')

  const sql = createPgPool(opts.databaseUrl)
  const applied = await hubMigrate(sql)
  if (applied.length > 0) console.log(`applied hub migrations: ${applied.join(', ')}`)

  const server = buildHubServer(sql)
  await server.listen({ host: '0.0.0.0', port: opts.port })
}
