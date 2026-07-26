import type { FastifyInstance } from 'fastify'

/**
 * Optional SDK control surface exposed by a live conductor. Keeping these
 * methods optional lets the read-only/test server continue to run without a
 * Claude session while giving the web console real interactive controls.
 */
export interface AgentSessionControlHost {
  mcpStatus?(agentId: number): Promise<unknown | null>
  toggleMcpServer?(agentId: number, name: string, enabled: boolean): Promise<unknown | null>
  reconnectMcpServer?(agentId: number, name: string): Promise<unknown | null>
  reloadPlugins?(agentId: number): Promise<unknown | null>
}

const message = (error: unknown) => error instanceof Error ? error.message : 'Claude session control failed'

const requireOperator = (req: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply): boolean => {
  if (req.orchestraPrincipal === 'operator') return true
  reply.code(403).send({ error: 'operator authorization is required for this action' })
  return false
}

export function registerAgentSessionControlRoutes(server: FastifyInstance, host?: AgentSessionControlHost): void {
  server.get<{ Params: { id: string } }>('/api/v1/agents/:id/mcp', async (req, reply) => {
    if (!host?.mcpStatus) return reply.code(501).send({ error: 'session controls are unavailable' })
    try {
      const servers = await host.mcpStatus(Number(req.params.id))
      return servers === null ? reply.code(404).send({ error: 'not a hired agent' }) : { servers }
    } catch (error) {
      return reply.code(502).send({ error: message(error) })
    }
  })

  server.post<{ Params: { id: string; name: string }; Body: { enabled?: unknown } | null }>(
    '/api/v1/agents/:id/mcp/:name/toggle', async (req, reply) => {
      if (!requireOperator(req, reply)) return
      if (!host?.toggleMcpServer) return reply.code(501).send({ error: 'session controls are unavailable' })
      if (typeof req.body?.enabled !== 'boolean') return reply.code(400).send({ error: 'enabled must be a boolean' })
      try {
        const servers = await host.toggleMcpServer(Number(req.params.id), req.params.name, req.body.enabled)
        return servers === null ? reply.code(404).send({ error: 'not a hired agent' }) : { ok: true, servers }
      } catch (error) {
        return reply.code(502).send({ error: message(error) })
      }
    })

  server.post<{ Params: { id: string; name: string } }>(
    '/api/v1/agents/:id/mcp/:name/reconnect', async (req, reply) => {
      if (!requireOperator(req, reply)) return
      if (!host?.reconnectMcpServer) return reply.code(501).send({ error: 'session controls are unavailable' })
      try {
        const servers = await host.reconnectMcpServer(Number(req.params.id), req.params.name)
        return servers === null ? reply.code(404).send({ error: 'not a hired agent' }) : { ok: true, servers }
      } catch (error) {
        return reply.code(502).send({ error: message(error) })
      }
    })

  server.post<{ Params: { id: string } }>('/api/v1/agents/:id/plugins/reload', async (req, reply) => {
    if (!requireOperator(req, reply)) return
    if (!host?.reloadPlugins) return reply.code(501).send({ error: 'session controls are unavailable' })
    try {
      const result = await host.reloadPlugins(Number(req.params.id))
      return result === null ? reply.code(404).send({ error: 'not a hired agent' }) : result
    } catch (error) {
      return reply.code(502).send({ error: message(error) })
    }
  })
}
