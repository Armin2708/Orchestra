import type Database from 'better-sqlite3'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import {
  claudeProviderCatalog,
  codexProviderCatalog,
  type AgentProviderCatalog,
} from './agent-providers.js'
import {
  registerAgentOsRoutes,
  type AgentOsRouteOptions,
} from './agent-os/routes.js'
import { CODEX_CAPABILITIES } from './provider-agent-manager.js'
import { resolveAgentMutationPrincipal } from './agent-os/agent-mutation-principal.js'

export type AgentOsServerRouteOptions = Omit<AgentOsRouteOptions, 'db'>

export interface AgentOsServerCompositionHost {
  providerCatalog?(): Promise<AgentProviderCatalog[]>
}

export interface AgentOsServerCompositionInput {
  db: Database.Database
  host?: AgentOsServerCompositionHost
  agentOs?: AgentOsServerRouteOptions
  isOperator: (request: FastifyRequest) => boolean
}

export const SERVER_COMPOSITION_CONTRACT = Object.freeze({
  role: 'composition_and_compatibility_routing',
  owns: Object.freeze([
    'Fastify lifecycle and authentication',
    'dependency injection',
    'focused route-plugin registration',
    'legacy compatibility route registration',
  ]),
  excludes: Object.freeze([
    'canonical domain state transitions',
    'canonical service construction',
    'domain persistence and validation rules',
  ]),
  canonical_route_registrar: 'registerAgentOsRoutes',
} as const)

const fallbackProviders = (): AgentProviderCatalog[] => [
  claudeProviderCatalog({
    available: false,
    detail: 'Requires the daemon Conductor before Claude models can be discovered.',
  }),
  codexProviderCatalog({
    available: false,
    capabilities: CODEX_CAPABILITIES,
    detail: 'Requires the daemon Codex app-server runtime.',
  }),
]

/**
 * Builds the canonical Agent OS route options from already-created runtime dependencies.
 *
 * This is intentionally composition-only: it does not construct a scheduler or domain service,
 * execute SQL, or define an HTTP handler. The focused route plugins retain those responsibilities.
 */
export function composeAgentOsRouteOptions(
  input: AgentOsServerCompositionInput,
): AgentOsRouteOptions {
  const defaultDrivers = () => [
    {
      id: 'claude',
      available: Boolean(input.host),
      capabilities: ['launch', 'attach', 'send', 'interrupt', 'events'],
      detail: input.host ? undefined : 'requires the daemon Conductor',
    },
    {
      id: 'codex',
      available: false,
      capabilities: ['launch', 'attach', 'send', 'interrupt', 'events'],
      detail: 'requires the daemon Codex app-server runtime',
    },
    {
      id: 'shell',
      available: Boolean(input.agentOs?.runtime),
      capabilities: ['launch', 'input', 'resize', 'signal', 'events'],
      detail: input.agentOs?.runtime ? undefined : 'requires the PTY runtime',
    },
  ]
  const defaultProviders = async () => input.host?.providerCatalog
    ? input.host.providerCatalog()
    : fallbackProviders()

  return {
    ...input.agentOs,
    db: input.db,
    drivers: input.agentOs?.drivers ?? defaultDrivers,
    providers: input.agentOs?.providers ?? defaultProviders,
    supportedProviders: input.agentOs?.supportedProviders
      ?? input.agentOs?.jobExecutor?.supportedProviders()
      ?? [],
    globalCapacity: input.agentOs?.globalCapacity ?? configuredGlobalCapacity(),
    perProfileCapacity: input.agentOs?.perProfileCapacity ?? configuredPerProfileCapacity(),
    isOperator: input.isOperator,
    resolveAgentPrincipal: input.agentOs?.resolveAgentPrincipal
      ?? ((request) => resolveAgentMutationPrincipal(input.db, request)),
  }
}

function configuredGlobalCapacity(): number {
  const value = Number(process.env.ORCHESTRA_MAX_LAUNCHED ?? 3)
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 3
}

function configuredPerProfileCapacity(): number {
  const value = Number(process.env.ORCHESTRA_MAX_PER_PROFILE ?? 1)
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 1
}

export function registerAgentOsServerComposition(
  server: FastifyInstance,
  input: AgentOsServerCompositionInput,
): void {
  registerAgentOsRoutes(server, composeAgentOsRouteOptions(input))
}
