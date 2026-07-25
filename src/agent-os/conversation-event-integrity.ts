import { canonicalHash } from './agent-home-support.js'

export interface ConversationEventIntegrityInput {
  provider: string | null
  provider_event_id: string | null
  provider_thread_id: string | null
  provider_turn_id: string | null
  provider_item_id: string | null
  provider_cursor: string | null
  kind: string
  actor: {
    type: string
    id: string | null
  }
  correlation_id: string | null
  causation_id: string | null
  projected_text: string | null
  metadata: Record<string, unknown>
  raw_artifact_id: string | null
  dedupe_key: string
  redaction_state: string
  retention_class: string
  schema_version: number
}

export function conversationEventContentHash(input: ConversationEventIntegrityInput): string {
  return canonicalHash({
    provider: input.provider,
    provider_event_id: input.provider_event_id,
    provider_thread_id: input.provider_thread_id,
    provider_turn_id: input.provider_turn_id,
    provider_item_id: input.provider_item_id,
    provider_cursor: input.provider_cursor,
    kind: input.kind,
    actor: input.actor,
    correlation_id: input.correlation_id,
    causation_id: input.causation_id,
    projected_text: input.projected_text,
    metadata: input.metadata,
    raw_artifact_id: input.raw_artifact_id,
    dedupe_key: input.dedupe_key,
    redaction_state: input.redaction_state,
    retention_class: input.retention_class,
    schema_version: input.schema_version,
  })
}
