import type { DriverEvent } from '../runtime/types.js'
import {
  CODEX_WITHHELD_REASONING_METHODS,
  redactProjectedText,
} from './projected-text-redaction.js'

export type ManagedDriverEventClassification = 'approval' | 'reasoning' | 'ordinary'

export interface ManagedDriverEventProjection {
  classification: ManagedDriverEventClassification
  payload: {
    seq: number
    data: string
    metadata: Record<string, unknown>
  }
}

const APPROVAL_METHOD_KINDS = new Map<string, string>([
  ['item/commandExecution/requestApproval', 'command'],
  ['item/fileChange/requestApproval', 'file-change'],
  ['item/permissions/requestApproval', 'permissions'],
  ['item/tool/requestUserInput', 'user-input'],
  ['mcpServer/elicitation/request', 'mcp-elicitation'],
])

const APPROVAL_KINDS = new Set(APPROVAL_METHOD_KINDS.values())

const SAFE_SCALAR_METADATA_KEYS = [
  'provider',
  'threadId',
  'turnId',
  'itemId',
  'nativeMethod',
  'method',
  'priorDroppedEvents',
  'turnCompleted',
  'turnActive',
  'status',
  'replayed',
  'reconnectReason',
  'itemCompleted',
  'unknownNativeEvent',
  'transcriptKind',
  'tokens',
  'costUsd',
  'subagentId',
  'subagentStatus',
  'agentStatus',
  'label',
  'willRetry',
  'reconnected',
  'lost',
  'reconnectFailed',
  'restartExhausted',
  'budgetExceeded',
  'budgetTokens',
  'detached',
  'unsubscribeStatus',
  'nativeCaptureFailed',
  'failedNativeMethod',
  'captureCursor',
  'control',
  'outputSeq',
  'stream',
  'source',
  'signal',
  'exitCode',
  'code',
  'reason',
  'redactionState',
] as const

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}

const stringValue = (value: unknown): string | null =>
  typeof value === 'string' && value ? value : null

const boundedRedacted = (value: string, maximum = 2_000): {
  value: string
  redactions: number
} => {
  const redacted = redactProjectedText(value)
  const safe = redacted.value ?? ''
  return {
    value: safe.length > maximum ? `${safe.slice(0, maximum - 3)}...` : safe,
    redactions: redacted.redactions,
  }
}

const providerLabel = (metadata: Record<string, unknown>, source?: string): string =>
  metadata.provider === 'codex' || source === 'codex'
    ? 'Codex'
    : metadata.provider === 'claude' || source === 'claude' ? 'Claude' : 'Provider'

const methodsFor = (metadata: Record<string, unknown>): string[] =>
  [stringValue(metadata.nativeMethod), stringValue(metadata.method)]
    .filter((value): value is string => value !== null)

const approvalKindFor = (metadata: Record<string, unknown>, methods: string[]): string => {
  const inferred = methods.map((method) => APPROVAL_METHOD_KINDS.get(method))
    .find((kind): kind is string => typeof kind === 'string')
  if (inferred) return inferred
  const explicit = stringValue(metadata.approvalKind)
  return explicit && APPROVAL_KINDS.has(explicit) ? explicit : 'tool'
}

const safeOrdinaryMetadata = (metadata: Record<string, unknown>): {
  value: Record<string, unknown>
  redactions: number
} => {
  const value: Record<string, unknown> = {}
  let redactions = 0
  for (const key of SAFE_SCALAR_METADATA_KEYS) {
    const item = metadata[key]
    if (typeof item === 'string') {
      const safe = boundedRedacted(item)
      value[key] = safe.value
      redactions += safe.redactions
    } else if (typeof item === 'boolean') {
      value[key] = item
    } else if (typeof item === 'number' && Number.isFinite(item)) {
      value[key] = item
    }
  }
  const plan = metadata.plan
  const planStepCount = Array.isArray(plan)
    ? plan.length
    : record(plan).steps && Array.isArray(record(plan).steps) ? (record(plan).steps as unknown[]).length : 0
  if (planStepCount > 0) value.plan = Array.from({ length: Math.min(planStepCount, 100) }, () => null)

  const receiverThreadIds = record(metadata.subagents).receiverThreadIds
  if (Array.isArray(receiverThreadIds)) {
    value.subagents = {
      receiverThreadIds: receiverThreadIds.slice(0, 100).flatMap((item) => {
        if (typeof item !== 'string') return []
        const safe = boundedRedacted(item, 512)
        redactions += safe.redactions
        return [safe.value]
      }),
    }
  }
  value.rawPayloadState = 'withheld'
  return { value, redactions }
}

export function projectManagedDriverEvent(
  event: Pick<DriverEvent, 'seq' | 'data' | 'metadata'>,
  source?: string,
): ManagedDriverEventProjection {
  const metadata = record(event.metadata)
  const methods = methodsFor(metadata)
  const reasoning = methods.some((method) => CODEX_WITHHELD_REASONING_METHODS.has(method))
    || metadata.kind === 'reasoning'
    || metadata.transcriptKind === 'thinking'
    || (metadata.reasoning === true && metadata.reasoningPayloadState === 'withheld')
  const seq = Number.isSafeInteger(Number(event.seq)) ? Number(event.seq) : 0
  if (reasoning) {
    return {
      classification: 'reasoning',
      payload: {
        seq,
        data: `${providerLabel(metadata, source)} reasoning withheld`,
        metadata: {
          reasoning: true,
          reasoningPayloadState: 'withheld',
          rawPayloadState: 'withheld',
        },
      },
    }
  }

  const approvalKind = approvalKindFor(metadata, methods)
  const approval = metadata.approval === true
    || metadata.kind === 'approval'
    || approvalKind !== 'tool'
  if (approval) {
    return {
      classification: 'approval',
      payload: {
        seq,
        data: `${providerLabel(metadata, source)} ${approvalKind} approval requested`,
        metadata: {
          approval: true,
          kind: 'approval',
          approvalKind,
          approvalPayloadState: 'withheld',
        },
      },
    }
  }

  const data = boundedRedacted(typeof event.data === 'string' ? event.data : '', 8_000)
  const safeMetadata = safeOrdinaryMetadata(metadata)
  if (data.redactions + safeMetadata.redactions > 0
    || metadata.redactionState === 'redacted') {
    safeMetadata.value.redactionState = 'redacted'
  }
  return {
    classification: 'ordinary',
    payload: {
      seq,
      data: data.value,
      metadata: safeMetadata.value,
    },
  }
}
