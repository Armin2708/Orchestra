import { createHash } from 'node:crypto'
import type {
  ContractAccessNeed,
  JobMarketContract,
  JobMarketCriterion,
} from './job-market.js'

export interface AgentBriefSelection {
  profile_id: string
  provider: string
  model: string | null
  access_profile: ContractAccessNeed
}

export interface AgentBriefDependency {
  card_id: number
  title: string
  state: string
  blocking_reason: string
  readiness: 'ready' | 'blocked'
}

export interface AgentBriefBlockerPath {
  path: Array<{
    card_id: number
    title: string
    state: string
    blocking_reason: string | null
  }>
  terminal: 'incomplete' | 'cycle' | 'invalid'
}

export interface RenderAgentBriefInput {
  job_market: JobMarketContract
  repository: string
  job_id?: string | null
  delivery_id?: string | null
  workspace_id?: string | null
  selection?: AgentBriefSelection | null
  dependencies?: readonly AgentBriefDependency[]
  critical_path?: readonly AgentBriefBlockerPath[]
}

export interface RenderedAgentBrief {
  agent_brief: string
  agent_brief_sha256: string
}

/**
 * One deterministic brief for preview and realized dispatch.
 *
 * The bytes intentionally exclude runtime-only identities so the preview digest can
 * be bound to matching, dispatch, persistence, retries, and the provider prompt.
 */
export function renderAgentBrief(input: RenderAgentBriefInput): RenderedAgentBrief {
  const market = input.job_market
  const contract = market.contract
  const deliverables = [...contract.deliverables]
    .sort((left, right) => compareText(left.id, right.id))
    .map((item) =>
      `- [${item.id}] ${item.text}${item.required === false ? ' (optional)' : ''}`)
    .join('\n')
  const criteria = [...market.criteria]
    .sort((left, right) => compareText(left.id, right.id))
    .map(criterionRow)
    .join('\n')
  const verification = contract.verify_commands
    .map((command) => `- ${command}`)
    .join('\n')
  const dependencies = [...(input.dependencies ?? [])]
    .sort((left, right) => left.card_id - right.card_id)
    .map((dependency) =>
      `- [card:${dependency.card_id}] ${dependency.title} — ${dependency.state}`
      + ` — ${dependency.readiness}: ${dependency.blocking_reason}`)
    .join('\n')
  const blockers = [...(input.critical_path ?? [])]
    .sort((left, right) => compareText(pathKey(left), pathKey(right)))
    .map((chain) =>
      `- ${chain.path.map((node) => {
        const reason = node.blocking_reason ? ` (${node.blocking_reason})` : ''
        return `[card:${node.card_id}] ${node.title}:${node.state}${reason}`
      }).join(' -> ')} [${chain.terminal}]`)
    .join('\n')
  const constraints = [
    `- Required capabilities: ${list(market.constraints.required_capabilities)}`,
    `- Allowed providers: ${list(market.constraints.provider_constraints)}`,
    `- Allowed models: ${list(market.constraints.model_constraints)}`,
    `- Required access: ${list(market.constraints.access_needs)}`,
  ].join('\n')
  const budgets = [
    `- Tokens: ${budget(market.budgets.tokens)}`,
    `- Cost cents: ${budget(market.budgets.cost_cents)}`,
    `- Time seconds: ${budget(market.budgets.time_seconds)}`,
    `- Retries: ${budget(market.budgets.retries)}`,
    `- Coordination tokens: ${budget(market.budgets.coordination_tokens)}`,
    `- Coordination messages: ${budget(market.budgets.coordination_messages)}`,
  ].join('\n')
  const risks = contract.risks.map((risk) => `- ${risk}`).join('\n')
  const nonGoals = contract.non_goals.map((nonGoal) => `- ${nonGoal}`).join('\n')

  const agentBrief = [
    'Agent OS delivery brief',
    `Objective: ${contract.objective}`,
    deliverables
      ? `Promised deliverables (stable IDs):\n${deliverables}`
      : 'Promised deliverables: none recorded.',
    criteria
      ? `Acceptance criteria (stable IDs):\n${criteria}`
      : 'Acceptance criteria: none recorded.',
    dependencies
      ? `Dependencies:\n${dependencies}`
      : 'Dependencies: none recorded.',
    blockers
      ? `Unresolved critical-path blockers:\n${blockers}`
      : 'Unresolved critical-path blockers: none.',
    `Constraints:\n${constraints}`,
    `Budgets:\n${budgets}`,
    verification
      ? `Required verification commands:\n${verification}`
      : 'Required verification commands: none recorded.',
    risks ? `Risks:\n${risks}` : 'Risks: none recorded.',
    nonGoals ? `Non-goals:\n${nonGoals}` : 'Non-goals: none recorded.',
    [
      `Repository: ${input.repository}`,
      `Base ref: ${contract.base_ref ?? '<not declared>'}`,
      `Policy: ${contract.policy_id ?? '<not declared>'}`,
    ].join('\n'),
    'Before stopping, submit the structured report with "orchestra delivery submit <job-id>"'
      + ' when that command is available. Claims are not verification evidence.',
    'Your final response MUST end with two concise sections: "Delivery summary:" describing what changed,'
      + ' and "Evidence:" listing the exact commands, artifacts, commits, or observed results.'
      + ' Do not move the card to done; the daemon parks a complete report in review.',
  ].join('\n\n')

  return {
    agent_brief: agentBrief,
    agent_brief_sha256: createHash('sha256').update(agentBrief).digest('hex'),
  }
}

function criterionRow(criterion: JobMarketCriterion): string {
  const artifacts = [...criterion.required_artifacts]
    .sort((left, right) =>
      compareText(
        `${left.kind}\u0000${left.name ?? ''}\u0000${left.description ?? ''}`,
        `${right.kind}\u0000${right.name ?? ''}\u0000${right.description ?? ''}`,
      ))
    .map((artifact) =>
      `${artifact.kind}${artifact.name ? `:${artifact.name}` : ''}`
      + `${artifact.description ? ` (${artifact.description})` : ''}`)
  return [
    `- [${criterion.id}] ${criterion.text}`
      + `${criterion.required === false ? ' (optional)' : ''}`,
    `  Description: ${criterion.description}`,
    `  Verifier: ${verifier(criterion)}`,
    `  Required artifacts: ${artifacts.length ? artifacts.join(', ') : 'none'}`,
    `  Priority/owner: ${criterion.priority} / ${criterion.owner ?? 'unassigned'}`,
  ].join('\n')
}

function verifier(criterion: JobMarketCriterion): string {
  const value = criterion.verifier
  return [
    value.kind,
    value.command ? `command=${value.command}` : null,
    value.artifact_kind ? `artifact_kind=${value.artifact_kind}` : null,
    value.instructions ? `instructions=${value.instructions}` : null,
  ].filter((part): part is string => part !== null).join('; ')
}

function list(values: readonly string[]): string {
  return values.length ? [...values].sort(compareText).join(', ') : 'none declared'
}

function budget(value: number | null): string {
  return value === null ? 'unbounded' : String(value)
}

function pathKey(path: AgentBriefBlockerPath): string {
  return path.path.map((node) => String(node.card_id).padStart(16, '0')).join('/')
    + `/${path.terminal}`
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}
