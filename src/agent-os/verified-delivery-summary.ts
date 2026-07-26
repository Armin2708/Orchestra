import type {
  CriterionOutcome,
  DeliveryClaim,
  DeliveryCriterionResult,
  DeliveryDeliverableResult,
  DeliveryItem,
  DeliveryReport,
  DeliveryStatus,
  EffectiveCriterionOutcome,
  EvidenceReference,
  EvidenceReferenceKind,
} from './delivery-reports.js'
import { isSensitiveMetadataKey, redactSensitiveText } from './structured-redaction.js'

export const VERIFIED_DELIVERY_SUMMARY_SCHEMA_VERSION = 1 as const
export const VERIFIED_DELIVERY_SUMMARY_FORMAT = 'verified-delivery-summary' as const

const DEFAULT_TEXT_BUDGET = 12_000
const DEFAULT_FIELD_LIMIT = 1_000
const DEFAULT_HUMAN_LIMIT = 24_000
const DEFAULT_MACHINE_LIMIT = 512_000
const DEFAULT_COLLECTION_LIMIT = 200
const DEFAULT_EVIDENCE_LIMIT = 100
const HARD_TEXT_BUDGET = 100_000
const HARD_FIELD_LIMIT = 10_000
const HARD_HUMAN_LIMIT = 100_000
const MIN_MACHINE_LIMIT = 64_000
const HARD_MACHINE_LIMIT = 2_000_000
const HARD_COLLECTION_LIMIT = 200
const HARD_EVIDENCE_LIMIT = 2_000
const MAX_IDENTIFIER_CHARACTERS = 2_048
const TRUNCATION_MARKER = '…'
const REDACTED_UNSAFE_URL = '[REDACTED_UNSAFE_URL]'

export interface VerifiedDeliverySummaryInput {
  /**
   * The latest accepted revision, already loaded by the caller. Its immutable
   * `asked` member is the only request snapshot summarized.
   */
  latestAcceptedReport: DeliveryReport
  /**
   * The caller's already-loaded current report. It is used only to state
   * whether the accepted revision is current; its request or claims are never
   * folded into the accepted summary.
   */
  currentReport: DeliveryReport | null
}

export interface VerifiedDeliverySummaryHistoryInput {
  reports: readonly DeliveryReport[]
  currentReport: DeliveryReport | null
}

export interface VerifiedDeliverySummaryOptions {
  /** Aggregate budget for source-authored prose included in the machine document. */
  textBudgetCharacters?: number
  /** Per-field ceiling within the aggregate prose budget. */
  maxFieldCharacters?: number
  /** Hard ceiling for the human rendering. */
  maxHumanCharacters?: number
  /** Hard ceiling for canonical pretty-printed machine JSON, including its final newline. */
  maxMachineCharacters?: number
  /** Per-collection ceiling; also the aggregate ceiling for criterion-to-deliverable links. */
  maxCollectionItems?: number
  /** Aggregate ceiling for evidence references across all included verification results. */
  maxEvidenceReferences?: number
}

export interface VerifiedDeliverySummaryEvidence {
  evidence_id: string
  kind: EvidenceReferenceKind
  label: string | null
}

export type VerifiedDeliverySummaryOutcome = CriterionOutcome | 'missing'
export type VerifiedDeliverySummaryEffectiveOutcome = EffectiveCriterionOutcome | 'missing'

export interface VerifiedDeliverySummaryResult {
  subject_id: string
  text: string
  required: boolean
  outcome: VerifiedDeliverySummaryOutcome
  effective_outcome: VerifiedDeliverySummaryEffectiveOutcome
  note: string | null
  evidence: VerifiedDeliverySummaryEvidence[]
  evidence_omitted_count: number
  override: {
    actor: string
    reason: string
    at: string
  } | null
  recorded_by: string | null
  recorded_at: string | null
}

export interface VerifiedDeliverySummaryGap {
  code:
    | 'reported'
    | 'delivery_item_missing'
    | 'delivery_item_incomplete'
    | 'verification_missing'
    | 'outcome_partial'
    | 'outcome_missed'
    | 'outcome_unverifiable'
    | 'evidence_missing'
    | 'verification_provenance_missing'
    | 'acceptance_provenance_missing'
  subject_kind: 'delivery' | 'deliverable' | 'criterion' | 'provenance'
  subject_id: string | null
  detail: string
}

export interface VerifiedDeliverySummary {
  schema_version: typeof VERIFIED_DELIVERY_SUMMARY_SCHEMA_VERSION
  format: typeof VERIFIED_DELIVERY_SUMMARY_FORMAT
  request: {
    objective: string
    contract_version: number
    contract_updated_at: string
    base_ref: string | null
    deliverables: Array<{
      deliverable_id: string
      text: string
      required: boolean
    }>
    acceptance_criteria: Array<{
      criterion_id: string
      text: string
      required: boolean
      deliverable_ids: string[]
    }>
    requested_verification_commands: string[]
    non_goals: string[]
    risks: string[]
    dependencies: number[]
    budget_tokens: number | null
    budget_cents: number | null
    priority: number
    policy_id: string | null
  }
  claims: {
    agent_summary: string | null
    delivered_items: Array<{
      item_id: string
      deliverable_id: string | null
      text: string
      status: DeliveryItem['status']
    }>
    assertions: Array<{
      claim_id: string
      criterion_id: string | null
      deliverable_id: string | null
      text: string
    }>
    claimed_changed_files: string[]
    claimed_commits: string[]
    claimed_artifact_ids: string[]
  }
  verification: {
    report_status: DeliveryStatus
    verified_by: string | null
    verified_at: string | null
    accepted_by: string | null
    accepted_at: string | null
    acceptance_note: string | null
    deliverables: VerifiedDeliverySummaryResult[]
    criteria: VerifiedDeliverySummaryResult[]
  }
  gaps: VerifiedDeliverySummaryGap[]
  provenance: {
    board_id: number
    card_id: number
    job_id: string | null
    session_id: string | null
    workspace_id: string | null
    report_id: string
    lineage_id: string
    parent_report_id: string | null
    revision: number
    created_by: string
    created_at: string
    report_updated_at: string
    submitted_by: string | null
    submitted_at: string | null
    current_report: {
      report_id: string
      lineage_id: string
      revision: number
      status: DeliveryStatus
      updated_at: string
    } | null
    selected_revision_is_current: boolean
  }
  redaction_policy: {
    version: 'verified-delivery-summary-v1'
    raw_artifact_content_included: false
    raw_command_output_included: false
    contract_metadata_included: false
    unsupported_url_references_replaced: true
    redactions_applied: number
  }
  truncation: {
    text_budget_characters: number
    max_field_characters: number
    max_human_characters: number
    max_machine_characters: number
    max_collection_items: number
    max_evidence_references: number
    text_characters_used: number
    machine_characters: number
    truncated_fields: string[]
    truncated_field_paths_omitted: number
    omitted_items: {
      request: {
        deliverables: number
        acceptance_criteria: number
        acceptance_criterion_deliverable_ids: number
        requested_verification_commands: number
        non_goals: number
        risks: number
        dependencies: number
      }
      claims: {
        delivered_items: number
        assertions: number
        claimed_changed_files: number
        claimed_commits: number
        claimed_artifact_ids: number
      }
      verification: {
        deliverables: number
        criteria: number
        evidence_references: number
      }
      gaps: number
    }
  }
}

export interface GeneratedVerifiedDeliverySummary {
  machine: VerifiedDeliverySummary
  human: string
  json: string
}

/**
 * Selects the newest accepted report without trusting caller order. Accepted
 * time is authoritative; revision and immutable provenance provide stable
 * tie-breakers for legacy rows with equal or missing timestamps.
 */
export function selectLatestAcceptedDeliveryRevision(
  reports: readonly DeliveryReport[],
): DeliveryReport | null {
  let latest: DeliveryReport | null = null
  for (const report of reports) {
    if (report.status !== 'accepted') continue
    if (!latest || compareAcceptedRevision(report, latest) > 0) latest = report
  }
  return latest
}

/**
 * Generates both bounded human and canonical machine renderings from loaded
 * reports. It returns null when the history has no accepted revision.
 */
export function generateVerifiedDeliverySummaryFromHistory(
  input: VerifiedDeliverySummaryHistoryInput,
  options: VerifiedDeliverySummaryOptions = {},
): GeneratedVerifiedDeliverySummary | null {
  const latestAcceptedReport = selectLatestAcceptedDeliveryRevision(input.reports)
  if (!latestAcceptedReport) return null
  return generateVerifiedDeliverySummary({
    latestAcceptedReport,
    currentReport: input.currentReport,
  }, options)
}

export function generateVerifiedDeliverySummary(
  input: VerifiedDeliverySummaryInput,
  options: VerifiedDeliverySummaryOptions = {},
): GeneratedVerifiedDeliverySummary {
  const machine = createVerifiedDeliverySummary(input, options)
  return {
    machine,
    human: renderVerifiedDeliverySummary(machine),
    json: serializeVerifiedDeliverySummary(machine),
  }
}

export function createVerifiedDeliverySummary(
  input: VerifiedDeliverySummaryInput,
  options: VerifiedDeliverySummaryOptions = {},
): VerifiedDeliverySummary {
  const report = input.latestAcceptedReport
  if (report.status !== 'accepted') {
    throw new TypeError('latestAcceptedReport must have accepted status')
  }
  if (input.currentReport
    && (input.currentReport.board_id !== report.board_id || input.currentReport.card_id !== report.card_id)) {
    throw new TypeError('currentReport must belong to the same board and card as latestAcceptedReport')
  }

  const limits = normalizeOptions(options)
  const text = new TextBudget(limits.textBudgetCharacters, limits.maxFieldCharacters)
  const asked = report.asked
  const deliverableOrder = new Map(asked.deliverables.map((item, index) => [item.id, index]))
  const requestDeliverableSource = takeItems(asked.deliverables, limits.maxCollectionItems)
  const requestCriterionSource = takeItems(asked.acceptance_criteria, limits.maxCollectionItems)
  const relationshipBudget = new ItemBudget(limits.maxCollectionItems)
  const verificationCommandSource = takeItems(asked.verify_commands, limits.maxCollectionItems)
  const nonGoalSource = takeItems(asked.non_goals, limits.maxCollectionItems)
  const riskSource = takeItems(asked.risks, limits.maxCollectionItems)
  const dependencySource = takeItems(stableUniqueNumbers(asked.dependencies), limits.maxCollectionItems)

  const requestObjective = text.prose(asked.objective, 'request.objective')
  const requestDeliverables = requestDeliverableSource.items.map((item, index) => ({
    deliverable_id: text.identity(item.id, `request.deliverables.${index}.deliverable_id`),
    text: text.prose(item.text, `request.deliverables.${index}.text`),
    required: item.required,
  }))
  const requestCriteria = requestCriterionSource.items.map((item, index) => {
    const deliverableIds = relationshipBudget.take(stableUnique(item.deliverable_ids))
    return {
      criterion_id: text.identity(item.id, `request.acceptance_criteria.${index}.criterion_id`),
      text: text.prose(item.text, `request.acceptance_criteria.${index}.text`),
      required: item.required,
      deliverable_ids: deliverableIds
        .map((id) => text.identity(id, `request.acceptance_criteria.${index}.deliverable_ids`)),
    }
  })
  const requestedVerificationCommands = verificationCommandSource.items
    .map((command, index) => text.prose(command, `request.requested_verification_commands.${index}`))
  const nonGoals = nonGoalSource.items
    .map((item, index) => text.prose(item, `request.non_goals.${index}`))
  const risks = riskSource.items
    .map((item, index) => text.prose(item, `request.risks.${index}`))
  const agentSummary = report.summary.trim()
    ? text.prose(report.summary, 'claims.agent_summary')
    : null

  const deliveredItemSource = takeItems(
    [...report.delivered_items].sort((left, right) =>
      compareDeliveredItems(left, right, deliverableOrder)),
    limits.maxCollectionItems,
  )
  const deliveredItems = deliveredItemSource.items
    .map((item, index) => ({
      item_id: text.identity(item.id, `claims.delivered_items.${index}.item_id`),
      deliverable_id: item.deliverable_id === null
        ? null
        : text.identity(item.deliverable_id, `claims.delivered_items.${index}.deliverable_id`),
      text: text.prose(item.text, `claims.delivered_items.${index}.text`),
      status: item.status,
    }))
  const assertionSource = takeItems(
    [...report.claims].sort(compareClaims),
    limits.maxCollectionItems,
  )
  const assertions = assertionSource.items
    .map((claim, index) => ({
      claim_id: text.identity(claim.id, `claims.assertions.${index}.claim_id`),
      criterion_id: claim.criterion_id === null
        ? null
        : text.identity(claim.criterion_id, `claims.assertions.${index}.criterion_id`),
      deliverable_id: claim.deliverable_id === null
        ? null
        : text.identity(claim.deliverable_id, `claims.assertions.${index}.deliverable_id`),
      text: text.prose(claim.text, `claims.assertions.${index}.text`),
    }))
  const changedFileSource = takeItems(stableUnique(report.changed_files), limits.maxCollectionItems)
  const commitSource = takeItems(stableUnique(report.commits), limits.maxCollectionItems)
  const artifactSource = takeItems(stableUnique(report.artifact_ids), limits.maxCollectionItems)

  const deliverableResults = indexDeliverableResults(report.deliverable_results)
  const criterionResults = indexCriterionResults(report.criterion_results)
  const evidenceBudget = new ItemBudget(limits.maxEvidenceReferences)
  const verificationDeliverables = requestDeliverableSource.items.map((item, index) =>
    summarizeResult(
      'deliverable',
      item.id,
      requestDeliverables[index]?.text ?? '',
      item.required,
      deliverableResults.get(item.id),
      index,
      text,
      evidenceBudget,
    ))
  const verificationCriteria = requestCriterionSource.items.map((item, index) =>
    summarizeResult(
      'criterion',
      item.id,
      requestCriteria[index]?.text ?? '',
      item.required,
      criterionResults.get(item.id),
      index,
      text,
      evidenceBudget,
    ))

  const gapSource = takeItems(
    buildGaps(report, deliverableResults, criterionResults, text),
    limits.maxCollectionItems,
  )
  const gaps = gapSource.items
  const totalEvidenceReferences = asked.deliverables.reduce(
    (total, item) => total + (deliverableResults.get(item.id)?.evidence_refs.length ?? 0),
    0,
  ) + asked.acceptance_criteria.reduce(
    (total, item) => total + (criterionResults.get(item.id)?.evidence_refs.length ?? 0),
    0,
  )
  const includedEvidenceReferences = [...verificationDeliverables, ...verificationCriteria]
    .reduce((total, result) => total + result.evidence.length, 0)
  const current = input.currentReport
  const machine: VerifiedDeliverySummary = {
    schema_version: VERIFIED_DELIVERY_SUMMARY_SCHEMA_VERSION,
    format: VERIFIED_DELIVERY_SUMMARY_FORMAT,
    request: {
      objective: requestObjective,
      contract_version: asked.contract_version,
      contract_updated_at: text.identity(asked.contract_updated_at, 'request.contract_updated_at'),
      base_ref: asked.base_ref === null ? null : text.identity(asked.base_ref, 'request.base_ref'),
      deliverables: requestDeliverables,
      acceptance_criteria: requestCriteria,
      requested_verification_commands: requestedVerificationCommands,
      non_goals: nonGoals,
      risks,
      dependencies: dependencySource.items,
      budget_tokens: asked.budget_tokens,
      budget_cents: asked.budget_cents,
      priority: asked.priority,
      policy_id: asked.policy_id === null ? null : text.identity(asked.policy_id, 'request.policy_id'),
    },
    claims: {
      agent_summary: agentSummary,
      delivered_items: deliveredItems,
      assertions,
      claimed_changed_files: changedFileSource.items
        .map((file, index) => text.prose(file, `claims.claimed_changed_files.${index}`)),
      claimed_commits: commitSource.items
        .map((commit, index) => text.identity(commit, `claims.claimed_commits.${index}`)),
      claimed_artifact_ids: artifactSource.items
        .map((artifactId, index) => text.identity(artifactId, `claims.claimed_artifact_ids.${index}`)),
    },
    verification: {
      report_status: report.status,
      verified_by: report.verified_by === null ? null : text.identity(report.verified_by, 'verification.verified_by'),
      verified_at: report.verified_at === null ? null : text.identity(report.verified_at, 'verification.verified_at'),
      accepted_by: report.accepted_by === null ? null : text.identity(report.accepted_by, 'verification.accepted_by'),
      accepted_at: report.accepted_at === null ? null : text.identity(report.accepted_at, 'verification.accepted_at'),
      acceptance_note: report.acceptance_note === null
        ? null
        : text.prose(report.acceptance_note, 'verification.acceptance_note'),
      deliverables: verificationDeliverables,
      criteria: verificationCriteria,
    },
    gaps,
    provenance: {
      board_id: report.board_id,
      card_id: report.card_id,
      job_id: report.job_id === null ? null : text.identity(report.job_id, 'provenance.job_id'),
      session_id: report.session_id === null ? null : text.identity(report.session_id, 'provenance.session_id'),
      workspace_id: report.workspace_id === null
        ? null
        : text.identity(report.workspace_id, 'provenance.workspace_id'),
      report_id: text.identity(report.id, 'provenance.report_id'),
      lineage_id: text.identity(report.lineage_id, 'provenance.lineage_id'),
      parent_report_id: report.parent_report_id === null
        ? null
        : text.identity(report.parent_report_id, 'provenance.parent_report_id'),
      revision: report.sequence,
      created_by: text.identity(report.created_by, 'provenance.created_by'),
      created_at: text.identity(report.created_at, 'provenance.created_at'),
      report_updated_at: text.identity(report.updated_at, 'provenance.report_updated_at'),
      submitted_by: report.submitted_by === null
        ? null
        : text.identity(report.submitted_by, 'provenance.submitted_by'),
      submitted_at: report.submitted_at === null
        ? null
        : text.identity(report.submitted_at, 'provenance.submitted_at'),
      current_report: current === null ? null : {
        report_id: text.identity(current.id, 'provenance.current_report.report_id'),
        lineage_id: text.identity(current.lineage_id, 'provenance.current_report.lineage_id'),
        revision: current.sequence,
        status: current.status,
        updated_at: text.identity(current.updated_at, 'provenance.current_report.updated_at'),
      },
      selected_revision_is_current: current?.id === report.id,
    },
    redaction_policy: {
      version: 'verified-delivery-summary-v1',
      raw_artifact_content_included: false,
      raw_command_output_included: false,
      contract_metadata_included: false,
      unsupported_url_references_replaced: true,
      redactions_applied: 0,
    },
    truncation: {
      text_budget_characters: limits.textBudgetCharacters,
      max_field_characters: limits.maxFieldCharacters,
      max_human_characters: limits.maxHumanCharacters,
      max_machine_characters: limits.maxMachineCharacters,
      max_collection_items: limits.maxCollectionItems,
      max_evidence_references: limits.maxEvidenceReferences,
      text_characters_used: 0,
      machine_characters: 0,
      truncated_fields: [],
      truncated_field_paths_omitted: 0,
      omitted_items: {
        request: {
          deliverables: requestDeliverableSource.omitted,
          acceptance_criteria: requestCriterionSource.omitted,
          acceptance_criterion_deliverable_ids: relationshipBudget.omitted,
          requested_verification_commands: verificationCommandSource.omitted,
          non_goals: nonGoalSource.omitted,
          risks: riskSource.omitted,
          dependencies: dependencySource.omitted,
        },
        claims: {
          delivered_items: deliveredItemSource.omitted,
          assertions: assertionSource.omitted,
          claimed_changed_files: changedFileSource.omitted,
          claimed_commits: commitSource.omitted,
          claimed_artifact_ids: artifactSource.omitted,
        },
        verification: {
          deliverables: requestDeliverableSource.omitted,
          criteria: requestCriterionSource.omitted,
          evidence_references: Math.max(0, totalEvidenceReferences - includedEvidenceReferences),
        },
        gaps: gapSource.omitted,
      },
    },
  }
  machine.redaction_policy.redactions_applied = text.redactions
  machine.truncation.text_characters_used = text.used
  const truncatedFieldSource = takeItems(
    [...text.truncated].sort(compareText),
    limits.maxCollectionItems,
  )
  machine.truncation.truncated_fields = truncatedFieldSource.items
  machine.truncation.truncated_field_paths_omitted = truncatedFieldSource.omitted
  enforceMachineCharacterLimit(machine)
  return machine
}

export function serializeVerifiedDeliverySummary(summary: VerifiedDeliverySummary): string {
  return `${JSON.stringify(sortJson(summary), null, 2)}\n`
}

export function renderVerifiedDeliverySummary(summary: VerifiedDeliverySummary): string {
  const current = summary.provenance.current_report
  const lines = [
    `# Verified delivery ${human(summary.provenance.report_id)}`,
    '',
    `Report status: ${summary.verification.report_status}`,
    `Verification: ${summary.verification.verified_at ?? 'not recorded'} by ${summary.verification.verified_by ?? 'not recorded'}`,
    `Acceptance: ${summary.verification.accepted_at ?? 'not recorded'} by ${summary.verification.accepted_by ?? 'not recorded'}`,
    `Current revision: ${summary.provenance.selected_revision_is_current ? 'yes' : 'no'}`,
    ...(current ? [`Current report: ${human(current.report_id)} (revision ${current.revision}, ${current.status})`] : []),
    '',
    '## Frozen request',
    '',
    summary.request.objective || '[text omitted by budget]',
    '',
    `Contract: v${summary.request.contract_version} (${human(summary.request.contract_updated_at)})`,
    `Base ref: ${human(summary.request.base_ref ?? 'none')}`,
    '',
    '### Deliverables',
    ...summary.request.deliverables.map((item) =>
      `- ${human(item.deliverable_id)} [${item.required ? 'required' : 'optional'}] — ${human(item.text || '[text omitted by budget]')}`),
    '',
    '### Acceptance criteria',
    ...summary.request.acceptance_criteria.map((item) =>
      `- ${human(item.criterion_id)} [${item.required ? 'required' : 'optional'}] — ${human(item.text || '[text omitted by budget]')}`),
    '',
    '## Agent claims (not evidence)',
    '',
    `Summary: ${human(summary.claims.agent_summary ?? 'none')}`,
    '',
    '### Claimed delivered items',
    ...(summary.claims.delivered_items.length
      ? summary.claims.delivered_items.map((item) =>
          `- ${human(item.deliverable_id ?? item.item_id)} status=${item.status} — ${human(item.text || '[text omitted by budget]')}`)
      : ['- None']),
    '',
    '### Claimed assertions',
    ...summary.claims.assertions.map((claim) => {
      const subjects = [
        claim.criterion_id ? `criterion=${human(claim.criterion_id)}` : null,
        claim.deliverable_id ? `deliverable=${human(claim.deliverable_id)}` : null,
      ].filter((value): value is string => value !== null).join(' ')
      return `- ${human(claim.claim_id)}${subjects ? ` (${subjects})` : ''} — ${human(claim.text || '[text omitted by budget]')}`
    }),
    ...(summary.claims.assertions.length ? [] : ['- None']),
    '',
    `Claimed changed files: ${summary.claims.claimed_changed_files.map(human).join(', ') || 'none'}`,
    `Claimed commits: ${summary.claims.claimed_commits.map(human).join(', ') || 'none'}`,
    `Claimed artifacts: ${summary.claims.claimed_artifact_ids.map(human).join(', ') || 'none'}`,
    '',
    '## Observed verification',
    '',
    '### Deliverables',
    ...summary.verification.deliverables.map(renderHumanResult),
    '',
    '### Acceptance criteria',
    ...summary.verification.criteria.map(renderHumanResult),
    '',
    '## Gaps',
    '',
    ...(summary.gaps.length
      ? summary.gaps.map((gap) =>
          `- ${gap.code}${gap.subject_id ? ` ${human(gap.subject_id)}` : ''}: ${human(gap.detail)}`)
      : ['- None']),
    '',
    '## Provenance',
    '',
    `Board/card: ${summary.provenance.board_id}/${summary.provenance.card_id}`,
    `Report/lineage/revision: ${human(summary.provenance.report_id)} / ${human(summary.provenance.lineage_id)} / ${summary.provenance.revision}`,
    `Created/updated: ${human(summary.provenance.created_at)} / ${human(summary.provenance.report_updated_at)}`,
    `Job/session/workspace: ${human(summary.provenance.job_id ?? 'none')} / ${human(summary.provenance.session_id ?? 'none')} / ${human(summary.provenance.workspace_id ?? 'none')}`,
    `Redactions applied: ${summary.redaction_policy.redactions_applied}`,
    `Truncated fields: ${summary.truncation.truncated_fields.length}`,
    `Machine size: ${summary.truncation.machine_characters}/${summary.truncation.max_machine_characters} characters`,
    `Omitted collection items: ${omittedItemCount(summary)}`,
  ]
  return boundHuman(`${lines.join('\n').trimEnd()}\n`, summary.truncation.max_human_characters)
}

function summarizeResult(
  kind: 'deliverable' | 'criterion',
  id: string,
  summarizedSubjectText: string,
  required: boolean,
  result: DeliveryDeliverableResult | DeliveryCriterionResult | undefined,
  index: number,
  text: TextBudget,
  evidenceBudget: ItemBudget,
): VerifiedDeliverySummaryResult {
  const path = `verification.${kind === 'criterion' ? 'criteria' : 'deliverables'}.${index}`
  if (!result) {
    return {
      subject_id: text.identity(id, `${path}.subject_id`),
      text: summarizedSubjectText,
      required,
      outcome: 'missing',
      effective_outcome: 'missing',
      note: null,
      evidence: [],
      evidence_omitted_count: 0,
      override: null,
      recorded_by: null,
      recorded_at: null,
    }
  }
  const evidence = summarizeEvidence(result.evidence_refs, path, text, evidenceBudget)
  return {
    subject_id: text.identity(id, `${path}.subject_id`),
    text: summarizedSubjectText,
    required,
    outcome: result.outcome,
    effective_outcome: result.effective_outcome,
    note: result.note === null ? null : text.prose(result.note, `${path}.note`),
    evidence: evidence.items,
    evidence_omitted_count: evidence.omitted,
    override: result.override === null ? null : {
      actor: text.identity(result.override.actor, `${path}.override.actor`),
      reason: text.prose(result.override.reason, `${path}.override.reason`),
      at: text.identity(result.override.at, `${path}.override.at`),
    },
    recorded_by: text.identity(result.actor, `${path}.recorded_by`),
    recorded_at: text.identity(result.updated_at, `${path}.recorded_at`),
  }
}

function summarizeEvidence(
  references: readonly EvidenceReference[],
  path: string,
  text: TextBudget,
  budget: ItemBudget,
): BoundedItems<VerifiedDeliverySummaryEvidence> {
  const sorted = [...references].sort(compareEvidence)
  const seen = new Set<string>()
  const evidence: VerifiedDeliverySummaryEvidence[] = []
  let omitted = 0
  for (let index = 0; index < sorted.length; index += 1) {
    const reference = sorted[index]
    if (!reference) continue
    if (!budget.available) {
      omitted += sorted.length - index
      break
    }
    const evidenceId = text.evidenceIdentity(
      reference,
      `${path}.evidence.evidence_id`,
    )
    const key = `${reference.kind}\u0000${evidenceId}`
    if (seen.has(key)) {
      omitted += 1
      continue
    }
    seen.add(key)
    if (!budget.consume()) {
      omitted += sorted.length - index
      break
    }
    evidence.push({
      evidence_id: evidenceId,
      kind: reference.kind,
      label: reference.label === null
        ? null
        : text.prose(reference.label, `${path}.evidence.${evidence.length}.label`),
    })
  }
  return { items: evidence, omitted }
}

function buildGaps(
  report: DeliveryReport,
  deliverableResults: ReadonlyMap<string, DeliveryDeliverableResult>,
  criterionResults: ReadonlyMap<string, DeliveryCriterionResult>,
  text: TextBudget,
): VerifiedDeliverySummaryGap[] {
  const gaps: VerifiedDeliverySummaryGap[] = []
  const reported = stableUnique(report.gaps)
    .map((gap, index) => text.prose(gap, `gaps.reported.${index}`))
  for (const detail of reported) {
    gaps.push({ code: 'reported', subject_kind: 'delivery', subject_id: null, detail })
  }

  for (const requested of report.asked.deliverables) {
    const subjectId = text.identity(requested.id, 'gaps.deliverable.subject_id')
    const item = report.delivered_items.find((candidate) =>
      candidate.deliverable_id === requested.id)
    if (!item) {
      gaps.push({
        code: 'delivery_item_missing',
        subject_kind: 'deliverable',
        subject_id: subjectId,
        detail: 'No delivered item represents this requested deliverable.',
      })
    } else if (item.status !== 'delivered') {
      gaps.push({
        code: 'delivery_item_incomplete',
        subject_kind: 'deliverable',
        subject_id: subjectId,
        detail: `The claimed delivery status is ${item.status}.`,
      })
    }
  }
  for (const requested of report.asked.deliverables) {
    addResultGaps(
      gaps,
      'deliverable',
      text.identity(requested.id, 'gaps.deliverable_result.subject_id'),
      deliverableResults.get(requested.id),
    )
  }
  for (const requested of report.asked.acceptance_criteria) {
    addResultGaps(
      gaps,
      'criterion',
      text.identity(requested.id, 'gaps.criterion_result.subject_id'),
      criterionResults.get(requested.id),
    )
  }
  if (report.verified_at === null || report.verified_by === null) {
    gaps.push({
      code: 'verification_provenance_missing',
      subject_kind: 'provenance',
      subject_id: text.identity(report.id, 'gaps.verification_provenance.report_id'),
      detail: 'Verifier identity or timestamp is not recorded.',
    })
  }
  if (report.accepted_at === null || report.accepted_by === null) {
    gaps.push({
      code: 'acceptance_provenance_missing',
      subject_kind: 'provenance',
      subject_id: text.identity(report.id, 'gaps.acceptance_provenance.report_id'),
      detail: 'Acceptance actor or timestamp is not recorded.',
    })
  }
  return deduplicateGaps(gaps)
}

function addResultGaps(
  gaps: VerifiedDeliverySummaryGap[],
  kind: 'deliverable' | 'criterion',
  subjectId: string,
  result: DeliveryDeliverableResult | DeliveryCriterionResult | undefined,
): void {
  if (!result) {
    gaps.push({
      code: 'verification_missing',
      subject_kind: kind,
      subject_id: subjectId,
      detail: 'No verification result is recorded.',
    })
    return
  }
  if (result.override) return
  if (result.outcome === 'met' && result.evidence_refs.length === 0) {
    gaps.push({
      code: 'evidence_missing',
      subject_kind: kind,
      subject_id: subjectId,
      detail: 'A met outcome has no evidence reference.',
    })
    return
  }
  if (result.outcome !== 'met') {
    gaps.push({
      code: `outcome_${result.outcome}`,
      subject_kind: kind,
      subject_id: subjectId,
      detail: `The recorded verification outcome is ${result.outcome}.`,
    })
  }
}

function indexDeliverableResults(
  results: readonly DeliveryDeliverableResult[],
): Map<string, DeliveryDeliverableResult> {
  return indexResults(results, (result) => result.deliverable_id)
}

function indexCriterionResults(
  results: readonly DeliveryCriterionResult[],
): Map<string, DeliveryCriterionResult> {
  return indexResults(results, (result) => result.criterion_id)
}

function indexResults<T>(
  results: readonly T[],
  identifier: (result: T) => string,
): Map<string, T> {
  const grouped = new Map<string, T[]>()
  for (const result of results) {
    const id = identifier(result)
    grouped.set(id, [...(grouped.get(id) ?? []), result])
  }
  return new Map([...grouped.entries()].map(([id, candidates]) => [
    id,
    [...candidates].sort((left, right) =>
      compareText(canonicalJson(left), canonicalJson(right)))[0],
  ]))
}

function compareAcceptedRevision(left: DeliveryReport, right: DeliveryReport): number {
  return compareTimestamps(left.accepted_at, right.accepted_at)
    || left.sequence - right.sequence
    || compareTimestamps(left.updated_at, right.updated_at)
    || compareTimestamps(left.created_at, right.created_at)
    || compareText(left.id, right.id)
}

function compareTimestamps(left: string | null, right: string | null): number {
  const leftTime = left === null ? Number.NaN : Date.parse(left)
  const rightTime = right === null ? Number.NaN : Date.parse(right)
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) {
    return leftTime - rightTime
  }
  if (Number.isFinite(leftTime) !== Number.isFinite(rightTime)) {
    return Number.isFinite(leftTime) ? 1 : -1
  }
  return compareText(left ?? '', right ?? '')
}

function compareDeliveredItems(
  left: DeliveryItem,
  right: DeliveryItem,
  order: ReadonlyMap<string, number>,
): number {
  const leftOrder = left.deliverable_id === null
    ? Number.MAX_SAFE_INTEGER
    : order.get(left.deliverable_id) ?? Number.MAX_SAFE_INTEGER
  const rightOrder = right.deliverable_id === null
    ? Number.MAX_SAFE_INTEGER
    : order.get(right.deliverable_id) ?? Number.MAX_SAFE_INTEGER
  return leftOrder - rightOrder
    || compareText(left.deliverable_id ?? '', right.deliverable_id ?? '')
    || compareText(left.id, right.id)
    || compareText(left.text, right.text)
}

function compareClaims(left: DeliveryClaim, right: DeliveryClaim): number {
  return compareText(left.id, right.id)
    || compareText(left.criterion_id ?? '', right.criterion_id ?? '')
    || compareText(left.deliverable_id ?? '', right.deliverable_id ?? '')
    || compareText(left.text, right.text)
}

function compareEvidence(left: EvidenceReference, right: EvidenceReference): number {
  return compareText(left.kind, right.kind)
    || compareText(left.ref, right.ref)
    || compareText(left.label ?? '', right.label ?? '')
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function stableUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareText)
}

function stableUniqueNumbers(values: readonly number[]): number[] {
  return [...new Set(values)].sort((left, right) => left - right)
}

function deduplicateGaps(gaps: VerifiedDeliverySummaryGap[]): VerifiedDeliverySummaryGap[] {
  const seen = new Set<string>()
  return gaps.filter((gap) => {
    const key = `${gap.code}\u0000${gap.subject_kind}\u0000${gap.subject_id ?? ''}\u0000${gap.detail}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function renderHumanResult(result: VerifiedDeliverySummaryResult): string {
  const evidence = result.evidence.length
    ? result.evidence.map((item) => `${item.kind}:${human(item.evidence_id)}`).join(', ')
    : 'none'
  const override = result.override
    ? `; override=${human(result.override.actor)} at ${human(result.override.at)} — ${human(result.override.reason || '[reason omitted by budget]')}`
    : ''
  const omitted = result.evidence_omitted_count > 0
    ? `; evidence_omitted=${result.evidence_omitted_count}`
    : ''
  return `- ${human(result.subject_id)} [${result.required ? 'required' : 'optional'}] outcome=${result.outcome} effective=${result.effective_outcome}; evidence=${evidence}${omitted}${override}`
}

function omittedItemCount(summary: VerifiedDeliverySummary): number {
  const omitted = summary.truncation.omitted_items
  return Object.values(omitted.request).reduce((total, count) => total + count, 0)
    + Object.values(omitted.claims).reduce((total, count) => total + count, 0)
    + Object.values(omitted.verification).reduce((total, count) => total + count, 0)
    + omitted.gaps
    + summary.truncation.truncated_field_paths_omitted
}

function human(value: string): string {
  return stripControls(value).replace(/\s+/g, ' ').trim()
}

function boundHuman(value: string, maximum: number): string {
  if (characterCount(value) <= maximum) return value
  const marker = '\n[human summary truncated; use the machine summary for complete structured IDs]\n'
  if (maximum <= characterCount(marker)) return sliceCharacters(marker, maximum)
  const available = maximum - characterCount(marker)
  const prefix = sliceCharacters(value, available)
  const newline = prefix.lastIndexOf('\n')
  const bounded = newline > 0 ? prefix.slice(0, newline) : prefix
  return `${bounded.trimEnd()}${marker}`
}

function normalizeOptions(options: VerifiedDeliverySummaryOptions): {
  textBudgetCharacters: number
  maxFieldCharacters: number
  maxHumanCharacters: number
  maxMachineCharacters: number
  maxCollectionItems: number
  maxEvidenceReferences: number
} {
  return {
    textBudgetCharacters: boundedOption(
      options.textBudgetCharacters,
      'textBudgetCharacters',
      DEFAULT_TEXT_BUDGET,
      HARD_TEXT_BUDGET,
    ),
    maxFieldCharacters: boundedOption(
      options.maxFieldCharacters,
      'maxFieldCharacters',
      DEFAULT_FIELD_LIMIT,
      HARD_FIELD_LIMIT,
    ),
    maxHumanCharacters: boundedOption(
      options.maxHumanCharacters,
      'maxHumanCharacters',
      DEFAULT_HUMAN_LIMIT,
      HARD_HUMAN_LIMIT,
    ),
    maxMachineCharacters: boundedOptionWithMinimum(
      options.maxMachineCharacters,
      'maxMachineCharacters',
      DEFAULT_MACHINE_LIMIT,
      MIN_MACHINE_LIMIT,
      HARD_MACHINE_LIMIT,
    ),
    maxCollectionItems: boundedOption(
      options.maxCollectionItems,
      'maxCollectionItems',
      DEFAULT_COLLECTION_LIMIT,
      HARD_COLLECTION_LIMIT,
    ),
    maxEvidenceReferences: boundedOption(
      options.maxEvidenceReferences,
      'maxEvidenceReferences',
      DEFAULT_EVIDENCE_LIMIT,
      HARD_EVIDENCE_LIMIT,
    ),
  }
}

function boundedOption(
  value: number | undefined,
  name: string,
  fallback: number,
  hardMaximum: number,
): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`)
  }
  return Math.min(value, hardMaximum)
}

function boundedOptionWithMinimum(
  value: number | undefined,
  name: string,
  fallback: number,
  minimum: number,
  hardMaximum: number,
): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new RangeError(`${name} must be a safe integer of at least ${minimum}`)
  }
  return Math.min(value, hardMaximum)
}

interface BoundedItems<T> {
  items: T[]
  omitted: number
}

class ItemBudget {
  private used = 0
  omitted = 0

  constructor(private readonly maximum: number) {}

  get available(): boolean {
    return this.used < this.maximum
  }

  consume(): boolean {
    if (!this.available) {
      this.omitted += 1
      return false
    }
    this.used += 1
    return true
  }

  take<T>(values: readonly T[]): T[] {
    const available = Math.max(0, this.maximum - this.used)
    const included = values.slice(0, available)
    this.used += included.length
    this.omitted += values.length - included.length
    return included
  }
}

function takeItems<T>(values: readonly T[], maximum: number): BoundedItems<T> {
  const items = values.slice(0, maximum)
  return { items, omitted: values.length - items.length }
}

interface MachineReduction {
  itemCount: number
  apply: (keep: number) => void
}

function enforceMachineCharacterLimit(summary: VerifiedDeliverySummary): void {
  const maximum = summary.truncation.max_machine_characters
  let measured = syncMachineCharacters(summary)
  if (measured <= maximum) return

  const reductionFactories: Array<() => MachineReduction> = [
    () => arrayReduction(
      summary.truncation.truncated_fields,
      summary.truncation.truncated_field_paths_omitted,
      (omitted) => { summary.truncation.truncated_field_paths_omitted = omitted },
    ),
    () => arrayReduction(
      summary.claims.claimed_changed_files,
      summary.truncation.omitted_items.claims.claimed_changed_files,
      (omitted) => { summary.truncation.omitted_items.claims.claimed_changed_files = omitted },
    ),
    () => arrayReduction(
      summary.claims.claimed_commits,
      summary.truncation.omitted_items.claims.claimed_commits,
      (omitted) => { summary.truncation.omitted_items.claims.claimed_commits = omitted },
    ),
    () => arrayReduction(
      summary.claims.claimed_artifact_ids,
      summary.truncation.omitted_items.claims.claimed_artifact_ids,
      (omitted) => { summary.truncation.omitted_items.claims.claimed_artifact_ids = omitted },
    ),
    () => arrayReduction(
      summary.claims.assertions,
      summary.truncation.omitted_items.claims.assertions,
      (omitted) => { summary.truncation.omitted_items.claims.assertions = omitted },
    ),
    () => arrayReduction(
      summary.claims.delivered_items,
      summary.truncation.omitted_items.claims.delivered_items,
      (omitted) => { summary.truncation.omitted_items.claims.delivered_items = omitted },
    ),
    () => arrayReduction(
      summary.request.requested_verification_commands,
      summary.truncation.omitted_items.request.requested_verification_commands,
      (omitted) => {
        summary.truncation.omitted_items.request.requested_verification_commands = omitted
      },
    ),
    () => arrayReduction(
      summary.request.non_goals,
      summary.truncation.omitted_items.request.non_goals,
      (omitted) => { summary.truncation.omitted_items.request.non_goals = omitted },
    ),
    () => arrayReduction(
      summary.request.risks,
      summary.truncation.omitted_items.request.risks,
      (omitted) => { summary.truncation.omitted_items.request.risks = omitted },
    ),
    () => arrayReduction(
      summary.request.dependencies,
      summary.truncation.omitted_items.request.dependencies,
      (omitted) => { summary.truncation.omitted_items.request.dependencies = omitted },
    ),
    () => criterionRelationshipReduction(summary),
    () => evidenceReduction(summary),
    () => arrayReduction(
      summary.gaps,
      summary.truncation.omitted_items.gaps,
      (omitted) => { summary.truncation.omitted_items.gaps = omitted },
    ),
    () => deliverableResultReduction(summary),
    () => criterionResultReduction(summary),
  ]

  for (const createReduction of reductionFactories) {
    if (measured <= maximum) break
    const reduction = createReduction()
    if (reduction.itemCount === 0) continue
    reduction.apply(0)
    measured = syncMachineCharacters(summary)
    if (measured > maximum) continue

    let lower = 0
    let upper = reduction.itemCount
    let best = 0
    while (lower <= upper) {
      const candidate = Math.floor((lower + upper) / 2)
      reduction.apply(candidate)
      measured = syncMachineCharacters(summary)
      if (measured <= maximum) {
        best = candidate
        lower = candidate + 1
      } else {
        upper = candidate - 1
      }
    }
    reduction.apply(best)
    measured = syncMachineCharacters(summary)
  }

  if (measured > maximum) {
    throw new RangeError(
      `maxMachineCharacters=${maximum} is too small for the fixed verified summary envelope`,
    )
  }
}

function arrayReduction<T>(
  target: T[],
  initialOmitted: number,
  updateOmitted: (omitted: number) => void,
): MachineReduction {
  const original = [...target]
  return {
    itemCount: original.length,
    apply: (keep) => {
      target.splice(0, target.length, ...original.slice(0, keep))
      updateOmitted(initialOmitted + original.length - keep)
    },
  }
}

function criterionRelationshipReduction(summary: VerifiedDeliverySummary): MachineReduction {
  const criteria = summary.request.acceptance_criteria
  const original = criteria.map((criterion) => [...criterion.deliverable_ids])
  const initialOmitted =
    summary.truncation.omitted_items.request.acceptance_criterion_deliverable_ids
  const itemCount = original.reduce((total, items) => total + items.length, 0)
  return {
    itemCount,
    apply: (keep) => {
      let remaining = keep
      for (let index = 0; index < criteria.length; index += 1) {
        const source = original[index] ?? []
        const count = Math.min(source.length, remaining)
        criteria[index]?.deliverable_ids.splice(
          0,
          criteria[index]?.deliverable_ids.length ?? 0,
          ...source.slice(0, count),
        )
        remaining -= count
      }
      summary.truncation.omitted_items.request.acceptance_criterion_deliverable_ids =
        initialOmitted + itemCount - keep
    },
  }
}

function evidenceReduction(summary: VerifiedDeliverySummary): MachineReduction {
  const results = [...summary.verification.deliverables, ...summary.verification.criteria]
  const original = results.map((result) => [...result.evidence])
  const initialPerResultOmitted = results.map((result) => result.evidence_omitted_count)
  const initialOmitted = summary.truncation.omitted_items.verification.evidence_references
  const itemCount = original.reduce((total, items) => total + items.length, 0)
  return {
    itemCount,
    apply: (keep) => {
      let remaining = keep
      for (let index = 0; index < results.length; index += 1) {
        const result = results[index]
        if (!result) continue
        const source = original[index] ?? []
        const count = Math.min(source.length, remaining)
        result.evidence.splice(0, result.evidence.length, ...source.slice(0, count))
        result.evidence_omitted_count = (initialPerResultOmitted[index] ?? 0)
          + source.length - count
        remaining -= count
      }
      summary.truncation.omitted_items.verification.evidence_references =
        initialOmitted + itemCount - keep
    },
  }
}

function criterionResultReduction(summary: VerifiedDeliverySummary): MachineReduction {
  const request = [...summary.request.acceptance_criteria]
  const verification = [...summary.verification.criteria]
  const initialRequestOmitted = summary.truncation.omitted_items.request.acceptance_criteria
  const initialVerificationOmitted = summary.truncation.omitted_items.verification.criteria
  const initialRelationshipOmitted =
    summary.truncation.omitted_items.request.acceptance_criterion_deliverable_ids
  const initialEvidenceOmitted =
    summary.truncation.omitted_items.verification.evidence_references
  return {
    itemCount: Math.min(request.length, verification.length),
    apply: (keep) => {
      summary.request.acceptance_criteria.splice(
        0,
        summary.request.acceptance_criteria.length,
        ...request.slice(0, keep),
      )
      summary.verification.criteria.splice(
        0,
        summary.verification.criteria.length,
        ...verification.slice(0, keep),
      )
      summary.truncation.omitted_items.request.acceptance_criteria =
        initialRequestOmitted + request.length - keep
      summary.truncation.omitted_items.verification.criteria =
        initialVerificationOmitted + verification.length - keep
      summary.truncation.omitted_items.request.acceptance_criterion_deliverable_ids =
        initialRelationshipOmitted + request.slice(keep)
          .reduce((total, criterion) => total + criterion.deliverable_ids.length, 0)
      summary.truncation.omitted_items.verification.evidence_references =
        initialEvidenceOmitted + verification.slice(keep)
          .reduce((total, result) => total + result.evidence.length, 0)
    },
  }
}

function deliverableResultReduction(summary: VerifiedDeliverySummary): MachineReduction {
  const request = [...summary.request.deliverables]
  const verification = [...summary.verification.deliverables]
  const initialRequestOmitted = summary.truncation.omitted_items.request.deliverables
  const initialVerificationOmitted = summary.truncation.omitted_items.verification.deliverables
  const initialEvidenceOmitted =
    summary.truncation.omitted_items.verification.evidence_references
  return {
    itemCount: Math.min(request.length, verification.length),
    apply: (keep) => {
      summary.request.deliverables.splice(
        0,
        summary.request.deliverables.length,
        ...request.slice(0, keep),
      )
      summary.verification.deliverables.splice(
        0,
        summary.verification.deliverables.length,
        ...verification.slice(0, keep),
      )
      summary.truncation.omitted_items.request.deliverables =
        initialRequestOmitted + request.length - keep
      summary.truncation.omitted_items.verification.deliverables =
        initialVerificationOmitted + verification.length - keep
      summary.truncation.omitted_items.verification.evidence_references =
        initialEvidenceOmitted + verification.slice(keep)
          .reduce((total, result) => total + result.evidence.length, 0)
    },
  }
}

function syncMachineCharacters(summary: VerifiedDeliverySummary): number {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const measured = characterCount(`${JSON.stringify(sortJson(summary), null, 2)}\n`)
    if (summary.truncation.machine_characters === measured) return measured
    summary.truncation.machine_characters = measured
  }
  return characterCount(`${JSON.stringify(sortJson(summary), null, 2)}\n`)
}

class TextBudget {
  used = 0
  redactions = 0
  readonly truncated = new Set<string>()

  constructor(
    private readonly total: number,
    private readonly perField: number,
  ) {}

  prose(value: string, path: string): string {
    const safe = this.safe(value)
    const remaining = Math.max(0, this.total - this.used)
    const maximum = Math.min(this.perField, remaining)
    const bounded = this.truncate(safe, path, maximum)
    this.used += characterCount(bounded)
    return bounded
  }

  identity(value: string, path: string): string {
    return this.truncate(this.safe(value), path, MAX_IDENTIFIER_CHARACTERS)
  }

  evidenceIdentity(reference: EvidenceReference, path: string): string {
    if (reference.kind !== 'url') return this.identity(reference.ref, path)
    const safeUrl = redactEvidenceUrl(reference.ref)
    if (!safeUrl.handled) {
      this.redactions += 1
      return REDACTED_UNSAFE_URL
    }
    this.redactions += safeUrl.redactions
    return this.truncate(
      stripControls(safeUrl.value).replace(/\s+/g, ' ').trim(),
      path,
      MAX_IDENTIFIER_CHARACTERS,
    )
  }

  private safe(value: string): string {
    const uriSafe = redactEmbeddedUriCredentials(value)
    const redacted = redactSensitiveText(uriSafe.value)
    this.redactions += uriSafe.redactions + redacted.redactions
    return stripControls(redacted.value ?? '').replace(/\s+/g, ' ').trim()
  }

  private truncate(value: string, path: string, maximum: number): string {
    if (characterCount(value) <= maximum) return value
    this.truncated.add(path)
    if (maximum === 0) return ''
    if (maximum === 1) return TRUNCATION_MARKER
    return `${sliceCharacters(value, maximum - 1)}${TRUNCATION_MARKER}`
  }
}

function redactEvidenceUrl(
  value: string,
): { value: string; redactions: number; handled: boolean } {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return { value, redactions: 0, handled: false }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { value, redactions: 0, handled: false }
  }

  let redactions = 0
  if (url.username || url.password) {
    url.username = ''
    url.password = ''
    redactions += 1
  }

  const safePath = redactDecodedUrlComponent(url.pathname)
  if (safePath.redactions > 0) {
    url.pathname = safePath.value
    redactions += safePath.redactions
  }

  const safeQuery = new URLSearchParams()
  for (const [key, value] of url.searchParams.entries()) {
    if (isSensitiveUrlKey(key)) {
      safeQuery.append(key, '[REDACTED]')
      if (value !== '[REDACTED]') redactions += 1
      continue
    }
    const safeValue = redactDecodedUrlComponent(value)
    safeQuery.append(key, safeValue.redactions > 0 ? safeValue.value : value)
    redactions += safeValue.redactions
  }
  url.search = safeQuery.toString()

  const safeFragment = redactUrlFragment(url.hash.slice(1))
  if (safeFragment.redactions > 0) {
    url.hash = safeFragment.value
    redactions += safeFragment.redactions
  }

  return { value: url.toString(), redactions, handled: true }
}

function isSensitiveUrlKey(key: string): boolean {
  return isSensitiveMetadataKey(decodeRepeatedly(key))
    || /(?:^|[_-])(?:signatures?|sigs?)(?:$|[_-])/i.test(decodeRepeatedly(key))
}

function redactUrlFragment(value: string): { value: string; redactions: number } {
  if (!value) return { value, redactions: 0 }
  let redactions = 0
  const segments = value.split('&').map((segment) => {
    const equals = segment.indexOf('=')
    if (equals >= 0) {
      const rawKey = segment.slice(0, equals)
      const rawItem = segment.slice(equals + 1)
      if (isSensitiveUrlKey(rawKey)) {
        if (decodeRepeatedly(rawItem) === '[REDACTED]') return segment
        redactions += 1
        return `${rawKey}=[REDACTED]`
      }
      const safeItem = redactDecodedUrlComponent(rawItem)
      redactions += safeItem.redactions
      return safeItem.redactions > 0
        ? `${rawKey}=${encodeURIComponent(safeItem.value)}`
        : segment
    }

    const decoded = decodeRepeatedly(segment)
    const decodedEquals = decoded.indexOf('=')
    if (decodedEquals >= 0 && isSensitiveUrlKey(decoded.slice(0, decodedEquals))) {
      if (decoded.slice(decodedEquals + 1) === '[REDACTED]') return segment
      redactions += 1
      return `${encodeURIComponent(decoded.slice(0, decodedEquals))}=[REDACTED]`
    }
    const safe = redactDecodedUrlComponent(segment)
    redactions += safe.redactions
    return safe.redactions > 0 ? encodeURIComponent(safe.value) : segment
  })
  if (redactions === 0) return { value, redactions }
  return { value: segments.join('&'), redactions }
}

function redactDecodedUrlComponent(value: string): { value: string; redactions: number } {
  const decoded = decodeRepeatedly(value)
  const uriSafe = redactEmbeddedUriCredentials(decoded)
  const redacted = redactSensitiveText(uriSafe.value)
  return {
    value: redacted.value ?? '',
    redactions: uriSafe.redactions + redacted.redactions,
  }
}

function redactEmbeddedUriCredentials(value: string): { value: string; redactions: number } {
  let redactions = 0
  const safe = value.replace(
    /\b([a-z][a-z0-9+.-]*:\/\/)([^/?#@\s]+)@/gi,
    (match, scheme: string | undefined, userInfo: string | undefined) => {
      if (!scheme || !userInfo || decodeRepeatedly(userInfo) === '[REDACTED]') return match
      redactions += 1
      return `${scheme}[REDACTED]@`
    },
  )
  return { value: safe, redactions }
}

function decodeRepeatedly(value: string): string {
  let decoded = value
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const next = decodeURIComponent(decoded)
      if (next === decoded) break
      decoded = next
    } catch {
      break
    }
  }
  return decoded
}

function stripControls(value: string): string {
  return value
    .replace(/\u001B(?:[@-_][0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\))/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '')
}

function characterCount(value: string): number {
  return Array.from(value).length
}

function sliceCharacters(value: string, maximum: number): string {
  return Array.from(value).slice(0, maximum).join('')
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value)) ?? 'null'
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => compareText(left, right))
        .map(([key, item]) => [key, sortJson(item)]),
    )
  }
  return value
}
