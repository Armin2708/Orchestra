import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  HubClient,
  HubConflictError,
  HubRequestError,
  HubRetryableError,
} from '../src/org-sync/hub-client.js'
import type { OrgCredential } from '../src/org-sync/credentials.js'

type Handler = (request: IncomingMessage, response: ServerResponse) => void | Promise<void>

let handler: Handler
let server: ReturnType<typeof createServer>
let client: HubClient

beforeEach(async () => {
  handler = (_request, response) => { response.writeHead(404).end() }
  server = createServer((request, response) => { void handler(request, response) })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  const credential: OrgCredential = {
    hubBaseUrl: `http://127.0.0.1:${port}`,
    orgId: 'org_example',
    deviceToken: 'orchestra_device_v1.secret-value',
    deviceName: 'workstation',
  }
  client = new HubClient(credential)
})

afterEach(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
})

const readJson = async (request: IncomingMessage): Promise<any> => {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

describe('HubClient', () => {
  it('posts an op with bearer auth and a generated idempotency key', async () => {
    handler = async (request, response) => {
      expect(request.url).toBe('/api/v1/hub/orgs/org_example/ops')
      expect(request.headers.authorization).toBe('Bearer orchestra_device_v1.secret-value')
      const body = await readJson(request)
      expect(body).toMatchObject({ op: 'card.create', payload: { title: 'A card' } })
      expect(body.idempotency_key).toMatch(/^[0-9a-f-]{36}$/)
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ result: { id: 'card_1' }, seq: 7 }))
    }

    await expect(client.postOp('card.create', { title: 'A card' })).resolves.toEqual({
      result: { id: 'card_1' },
      seq: 7,
    })
  })

  it('uses a caller-provided idempotency key unchanged', async () => {
    handler = async (request, response) => {
      expect((await readJson(request)).idempotency_key).toBe('stable-key')
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ result: {}, seq: 0 }))
    }

    await client.postOp('agent.heartbeat', { state: 'idle' }, 'stable-key')
  })

  it('throws a conflict carrying the current entity', async () => {
    handler = (_request, response) => {
      response.writeHead(409, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'card changed', current: { id: 'card_1', version: 3 } }))
    }

    const failure = client.postOp('card.update', { card_id: 'card_1' })
    await expect(failure).rejects.toBeInstanceOf(HubConflictError)
    await expect(failure).rejects.toMatchObject({ current: { id: 'card_1', version: 3 }, retryable: false })
  })

  it('distinguishes auth, ordinary client, and retryable server errors', async () => {
    for (const [status, ErrorType, message] of [
      [403, HubRequestError, 'token may be invalid, revoked, or for another organization'],
      [400, HubRequestError, 'bad request'],
      [503, HubRetryableError, 'temporarily unavailable'],
    ] as const) {
      handler = (_request, response) => {
        response.writeHead(status, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: message }))
      }
      const failure = client.get('boards')
      await expect(failure).rejects.toBeInstanceOf(ErrorType)
      await expect(failure).rejects.toMatchObject({ retryable: status >= 500, status })
      await expect(failure).rejects.toThrow(status === 403 ? 'token may be invalid' : message)
    }
  })

  it('parses split SSE frames in order and ignores ping comments', async () => {
    handler = (request, response) => {
      expect(request.url).toBe('/api/v1/hub/orgs/org_example/sync?since=4')
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(': ping\n\n')
      response.write('id: 5\ndata: {"seq":5,"kind":"card.created"')
      response.write(',"payload":{"id":"card_1"}}\n\n')
      response.write('data: {"seq":6,"kind":"card.moved","payload":{}}\n\n')
      response.end()
    }
    const seen: number[] = []

    await client.streamSince(4, async (event: any) => { seen.push(event.seq) }, new AbortController().signal)

    expect(seen).toEqual([5, 6])
  })

  it('honours an abort signal on a live stream', async () => {
    handler = (_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(': ping\n\n')
    }
    const controller = new AbortController()
    const streaming = client.streamSince(0, async () => undefined, controller.signal)
    controller.abort()

    await expect(streaming).rejects.toMatchObject({ name: 'AbortError' })
  })
})
