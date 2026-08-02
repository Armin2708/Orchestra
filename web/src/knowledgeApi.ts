import { api } from './api'

export type KnowledgeFreshness = 'fresh' | 'stale' | 'unknown' | 'contradicted'
export type KnowledgeAction = 'accept' | 'edit' | 'pin' | 'reject' | 'supersede' | 'forget'

export type KnowledgeCitation = {
  source_id: string
  chunk_id: string
  title: string
  source_kind: string
  locator: string
  source_revision: string
  source_content_sha256: string
  chunk_content_sha256: string
  repository_key: string
  repository_head_sha: string | null
  freshness: KnowledgeFreshness
  freshness_reason: string | null
  start_line: number | null
  end_line: number | null
  estimated_tokens: number
  pinned: boolean
}

export type KnowledgeItem = {
  content: string
  content_trust: 'untrusted_data'
  citation: KnowledgeCitation
  pending_review: 'stale' | 'contradiction' | null
  disposition: Exclude<KnowledgeAction, 'pin'> | null
}

export type KnowledgeReview = {
  id: string
  source_id: string
  kind: 'stale' | 'contradiction'
  status: 'pending' | 'resolved' | 'superseded'
  title: string
  normalized_locator: string
  effective_freshness: KnowledgeFreshness
  freshness_reason: string
  repository_head_sha: string
  requested_at: string
}

export type KnowledgePromotion = {
  id: string
  kind: 'accepted_answer' | 'verified_delivery'
  status: 'pending' | 'promoted' | 'rejected'
  requested_by: string
  requested_at: string
  promoted_source_count: number
}

export type KnowledgeManifestEntry = {
  source_id: string
  chunk_id: string
  selected: boolean
  why_included: string
  estimated_tokens: number
  token_contribution_percent: number
  citation: KnowledgeCitation
}

const idempotencyKey = (operation: string): string =>
  `${operation}:${crypto.randomUUID()}`

const list = <T>(raw: unknown, key: string): T[] => {
  const record = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  return Array.isArray(record[key]) ? record[key] as T[] : []
}

export const knowledgeApi = {
  browse: async (boardId: number, input: {
    query?: string; includeStale?: boolean; includeRejected?: boolean; limit?: number
  } = {}): Promise<KnowledgeItem[]> => {
    const query = new URLSearchParams()
    if (input.query) query.set('q', input.query)
    if (input.includeStale) query.set('include_stale', 'true')
    if (input.includeRejected) query.set('include_rejected', 'true')
    if (input.limit) query.set('limit', String(input.limit))
    const suffix = query.size ? `?${query}` : ''
    return list<KnowledgeItem>(await api('GET', `/os/boards/${boardId}/knowledge${suffix}`), 'knowledge')
  },
  reviews: async (boardId: number): Promise<KnowledgeReview[]> =>
    list<KnowledgeReview>(await api('GET', `/os/boards/${boardId}/knowledge/reviews`), 'reviews'),
  promotions: async (boardId: number): Promise<KnowledgePromotion[]> =>
    list<KnowledgePromotion>(await api('GET', `/os/boards/${boardId}/knowledge/promotions`), 'promotions'),
  refresh: async (boardId: number): Promise<void> => {
    await api('POST', `/os/boards/${boardId}/knowledge/refresh`, {})
  },
  control: async (boardId: number, sourceId: string, input: {
    action: KnowledgeAction
    reason: string
    replacementSourceId?: string
    pinned?: boolean
  }): Promise<void> => {
    await api('POST', `/os/boards/${boardId}/knowledge/sources/${encodeURIComponent(sourceId)}/actions`, {
      action: input.action,
      reason: input.reason,
      replacement_source_id: input.replacementSourceId,
      pinned: input.pinned,
      idempotency_key: idempotencyKey(`knowledge:${input.action}`),
    })
  },
  reviewPromotion: async (
    boardId: number,
    promotionId: string,
    decision: 'promote' | 'reject',
    reason: string,
  ): Promise<void> => {
    await api('POST', `/os/boards/${boardId}/knowledge/promotions/${encodeURIComponent(promotionId)}/review`, {
      decision,
      reason,
    })
  },
  manifest: async (boardId: number, buildId: string): Promise<KnowledgeManifestEntry[]> =>
    list<KnowledgeManifestEntry>(await api(
      'GET',
      `/os/context-builds/${encodeURIComponent(buildId)}/knowledge-manifest?board_id=${boardId}`,
    ), 'manifest'),
}
