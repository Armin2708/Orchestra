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

  program.command('hub')
    .description('run the hosted multi-org hub server')
    // No CLI default here: falling back to `env.PORT` (Railway's supplied port)
    // only works if an omitted `--port` is distinguishable from an explicit one.
    .option('--port <port>', 'port to listen on')
    .action(async (options: { port?: string }) => {
      const databaseUrl = env.HUB_DATABASE_URL ?? env.DATABASE_URL
      if (!databaseUrl) {
        throw new Error('HUB_DATABASE_URL (or DATABASE_URL) must be set to run the hub')
      }
      const rawPort = options.port ?? env.PORT ?? '4760'
      const port = Number(rawPort)
      if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        throw new Error(`--port must be a valid port number, got ${rawPort}`)
      }

      const start = deps.startHub ?? defaultStartHub
      output(`orchestra hub starting on port ${port}`)
      await start({ port, databaseUrl })
    })
}

/**
 * `opts.port`/`opts.databaseUrl` come from the CLI action above (which already
 * validated them with its own `--port`-aware error messages); `webOrigin` and
 * `clerkSecretKey` are read straight from `hubEnv()` here, the same way
 * `src/hub-entry.ts`'s `main()` reads them for the Railway entrypoint. Before
 * this, a local `orchestra hub` run silently ignored both — Clerk tokens
 * always hit the generic 403 body, indistinguishable from a misconfigured
 * Clerk application, with nothing in the boot output to say why.
 */
async function defaultStartHub(opts: { port: number; databaseUrl: string }): Promise<void> {
  const { hubEnv } = await import('./hub/env.js')
  const { createPgPool } = await import('./hub/pg.js')
  const { hubMigrate } = await import('./hub/migrations.js')
  const { buildHubServer } = await import('./hub/server.js')

  const env = hubEnv()
  const sql = createPgPool(opts.databaseUrl)
  const applied = await hubMigrate(sql)
  if (applied.length > 0) console.log(`applied hub migrations: ${applied.join(', ')}`)
  // Never log the key itself — only whether one is configured.
  console.log(`clerk auth: ${env.clerkSecretKey ? 'enabled' : 'disabled'}`)
  console.log(`stripe billing: ${env.stripeSecretKey ? 'enabled' : 'disabled'}`)

  const server = buildHubServer(sql, {
    webOrigin: env.webOrigin,
    clerkSecretKey: env.clerkSecretKey,
    clerkWebhookSigningSecret: env.clerkWebhookSigningSecret,
    stripeSecretKey: env.stripeSecretKey,
    stripeWebhookSecret: env.stripeWebhookSecret,
  })
  await server.listen({ host: '0.0.0.0', port: opts.port })
}
