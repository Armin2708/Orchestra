export type DiscussionType =
  | 'question' | 'answer' | 'plan' | 'decision' | 'announcement' | 'conflict'
export type DiscussionState =
  | 'open' | 'answered' | 'resolved' | 'needs_human' | 'archived' | 'superseded'

export interface DiscussionSummary {
  id: string
  board_id: number
  discussion_type: DiscussionType
  state: DiscussionState
  title: string
  body: string
  accepted_post_id: string | null
  resolution_summary: string | null
  updated_at: string
}

export interface DiscussionPostNode {
  id: string
  discussion_id: string
  parent_post_id: string | null
  post_kind: string
  body: string
  content_sha256: string
  author_type: string
  author_id: string
  author_profile_id: string | null
  provider: string | null
  session_id: string | null
  automated: boolean
  version: number
  created_at: string
  mentions: string[]
  children: DiscussionPostNode[]
}

export interface DiscussionSnapshot {
  discussion: DiscussionSummary
  tags: string[]
  links: Array<Record<string, unknown>>
  subscriptions: string[]
  posts: DiscussionPostNode[]
  tree: DiscussionPostNode[]
}

export type DiscussionListQuery = {
  q?: string
  queue?: 'unanswered' | 'needs_human'
  linkType?: string
  linkTarget?: string
  type?: DiscussionType
  state?: DiscussionState
}

export interface DiscussionClient {
  list(boardId: number, query?: DiscussionListQuery): Promise<DiscussionSummary[]>
  get(id: string): Promise<DiscussionSnapshot>
  create(boardId: number, body: Record<string, unknown>): Promise<DiscussionSnapshot>
  reply(id: string, body: Record<string, unknown>): Promise<DiscussionPostNode>
  accept(id: string, postId: string): Promise<DiscussionSnapshot>
  transition(id: string, state: DiscussionState, resolutionSummary?: string): Promise<DiscussionSnapshot>
  requestPromotion(id: string, postId: string): Promise<Record<string, unknown>>
  subscribe(id: string, profileId: string, subscribed: boolean): Promise<DiscussionSnapshot>
}

const commandKey = (scope: string) =>
  `orchestra-web:discussion:${scope}:${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`}`

async function request<T>(
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(`/api/v1/os${path}`, {
    method,
    cache: 'no-store',
    headers: {
      'content-type': 'application/json',
      ...(getToken() ? { authorization: `Bearer ${getToken()}` } : {}),
      ...(method === 'GET' ? {} : { 'idempotency-key': commandKey(path) }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { error?: string }
    throw new Error(payload.error ?? `Discussion request failed (${response.status})`)
  }
  return response.json() as Promise<T>
}

export const discussionApi: DiscussionClient = {
  async list(boardId, query = {}) {
    const params = new URLSearchParams()
    if (query.q) params.set('q', query.q)
    if (query.queue) params.set('queue', query.queue)
    if (query.linkType) params.set('link_type', query.linkType)
    if (query.linkTarget) params.set('link_target', query.linkTarget)
    if (query.type) params.set('type', query.type)
    if (query.state) params.set('state', query.state)
    const payload = await request<{ discussions: DiscussionSummary[] }>(
      'GET',
      `/boards/${boardId}/discussions${params.size ? `?${params}` : ''}`,
    )
    return payload.discussions
  },
  get: (id) => request('GET', `/discussions/${encodeURIComponent(id)}`),
  create: (boardId, body) => request('POST', `/boards/${boardId}/discussions`, body),
  async reply(id, body) {
    const payload = await request<{ post: DiscussionPostNode }>(
      'POST', `/discussions/${encodeURIComponent(id)}/posts`, body,
    )
    return payload.post
  },
  accept: (id, postId) => request('POST', `/discussions/${encodeURIComponent(id)}/accept`, {
    post_id: postId,
  }),
  transition: (id, state, resolutionSummary) => request(
    'POST',
    `/discussions/${encodeURIComponent(id)}/transition`,
    { state, resolution_summary: resolutionSummary },
  ),
  async requestPromotion(id, postId) {
    const payload = await request<{ promotion: Record<string, unknown> }>(
      'POST',
      `/discussions/${encodeURIComponent(id)}/posts/${encodeURIComponent(postId)}/promotion`,
      {},
    )
    return payload.promotion
  },
  subscribe: (id, profileId, subscribed) => request(
    subscribed ? 'PUT' : 'DELETE',
    `/discussions/${encodeURIComponent(id)}/subscriptions/${encodeURIComponent(profileId)}`,
    {},
  ),
}
import { getToken } from './api'
