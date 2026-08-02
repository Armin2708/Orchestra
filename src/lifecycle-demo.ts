import type { AgentOsApi } from './agent-os-cli.js'

export type LifecycleDemoResult = {
  board_id: number
  card_id: number
  contract_version: number | null
  job_id: string | null
  state: 'contract_published' | 'job_created'
  next_step: string
}

const objectId = (value: unknown, label: string): string | number => {
  if (typeof value === 'string' && value.trim()) return value
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value
  throw new Error(`demo response is missing ${label}`)
}

/**
 * Creates real Board + WorkContract records and optionally a real Job. The safe
 * default stops before provider execution so the demo cannot incur usage or
 * mutate a workspace without an explicit launch decision.
 */
export const runLifecycleDemo = async (
  api: AgentOsApi,
  input: {
    project_root: string
    launch?: boolean
    provider?: 'claude' | 'codex'
    idempotency_prefix?: string
  },
): Promise<LifecycleDemoResult> => {
  const prefix = input.idempotency_prefix?.trim() || 'orchestra-lifecycle-demo-v1'
  const board = await api('POST', '/boards/resolve', { project_path: input.project_root })
  const boardId = Number(objectId(board?.id ?? board?.board?.id, 'board id'))
  const created = await api('POST', '/cards', {
    board_id: boardId,
    title: 'Orchestra lifecycle demo',
    description: 'A real, reviewable Create → Contract → Publish lifecycle sample.',
    paths: ['docs/lifecycle-demo.md'],
    column: 'backlog',
  })
  const cardId = Number(objectId(created?.card?.id ?? created?.id, 'card id'))
  const current = await api('GET', `/os/cards/${cardId}/contract`)
  const marketVersion = Number(current?.job_market?.market_version ?? 0)
  const updated = await api('PUT', `/os/cards/${cardId}/contract`, {
    objective: 'Review the lifecycle demo and produce evidence without changing product code.',
    deliverables: [{
      id: 'demo-report',
      text: 'Lifecycle demo report',
      required: true,
      metadata: { sample: true },
    }],
    acceptance_criteria: [{
      id: 'demo-evidence',
      text: 'Observed evidence is attached',
      required: true,
      deliverable_ids: ['demo-report'],
      metadata: { sample: true },
      verifier: { kind: 'human' },
    }],
    non_goals: ['No provider API billing', 'No automatic shipping'],
    risks: ['Provider support may still be candidate or unsupported'],
    verify_commands: ['git status --short'],
    provider_constraints: [input.provider ?? 'codex'],
    access_needs: ['read_only'],
    budget_retries: 0,
    expected_market_version: marketVersion,
  })
  await api('POST', `/os/cards/${cardId}/contract/publish`, {
    actor: 'human',
    expected_market_version: Number(updated?.job_market?.market_version ?? marketVersion),
  })
  const contractVersion = Number(updated?.contract?.version ?? updated?.version)
  if (!input.launch) {
    return {
      board_id: boardId,
      card_id: cardId,
      contract_version: Number.isSafeInteger(contractVersion) ? contractVersion : null,
      job_id: null,
      state: 'contract_published',
      next_step: `Run doctor, inspect contract ${cardId}, then explicitly create a native-subscription job when the provider gate is satisfied.`,
    }
  }
  const job = await api('POST', `/os/boards/${boardId}/jobs`, {
    card_id: cardId,
    provider: input.provider ?? 'codex',
    max_attempts: 1,
    budget_tokens: 8_000,
    idempotency_key: `${prefix}:job:${boardId}:${cardId}`,
  })
  return {
    board_id: boardId,
    card_id: cardId,
    contract_version: Number.isSafeInteger(contractVersion) ? contractVersion : null,
    job_id: String(objectId(job?.job?.id ?? job?.id, 'job id')),
    state: 'job_created',
    next_step: 'Inspect the immutable Asked snapshot, submit evidence, verify independently, then accept or reject the Delivery.',
  }
}
