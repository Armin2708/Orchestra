import type { DriverEvent } from './types.js'

export type DriverTranscriptKind = 'text' | 'status' | 'error' | 'user' | 'tool' | 'tool_result' | 'thinking'

export type DriverTranscriptLine = {
  at: string
  kind: DriverTranscriptKind
  text: string
  metadata?: Record<string, unknown>
}

const QUIET_METHODS = new Set([
  'turn/started',
  'thread/tokenUsage/updated',
  'thread/status/changed',
])

const TOOL_OUTPUT_METHODS = new Set([
  'item/commandExecution/outputDelta',
  'item/fileChange/outputDelta',
  'process/outputDelta',
  'command/exec/outputDelta',
])

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

const stringValue = (value: unknown): string | undefined =>
  typeof value === 'string' && value ? value : undefined

const safeMetadata = (metadata: Record<string, unknown>): Record<string, unknown> => {
  const {
    native: _native,
    tokenUsage: _tokenUsage,
    usage: _usage,
    diff: _diff,
    plan: _plan,
    item: _item,
    ...safe
  } = metadata
  return safe
}

const planStepCount = (metadata: Record<string, unknown>): number => {
  if (Array.isArray(metadata.plan)) return metadata.plan.length
  if (isRecord(metadata.plan) && Array.isArray(metadata.plan.steps)) return metadata.plan.steps.length
  return 0
}

const presentation = (event: DriverEvent): {
  kind: DriverTranscriptKind
  text: string
  key?: string
  mode?: 'append' | 'replace'
} | null => {
  const metadata = event.metadata ?? {}
  const method = stringValue(metadata.nativeMethod) ?? stringValue(metadata.method)
  const itemId = stringValue(metadata.itemId)
  const turnId = stringValue(metadata.turnId)

  if (!event.data || metadata.unknownNativeEvent === true) return null
  if (method && QUIET_METHODS.has(method) && event.type !== 'error') return null

  if (method === 'item/reasoning/summaryPartAdded' && event.data === method) return null

  if (method === 'turn/completed' && event.type !== 'error') {
    const status = stringValue(metadata.status) ?? 'completed'
    return { kind: 'status', text: `turn finished (${status})` }
  }

  if (method === 'turn/plan/updated') {
    const count = planStepCount(metadata)
    return { kind: 'status', text: count ? `plan updated · ${count} step${count === 1 ? '' : 's'}` : 'plan updated' }
  }

  if (method === 'turn/diff/updated') return { kind: 'status', text: 'working tree diff updated' }

  if (method === 'item/agentMessage/delta') {
    const key = itemId ?? turnId
    return { kind: 'text', text: event.data, ...(key ? { key: `assistant:${key}`, mode: 'append' as const } : {}) }
  }

  if (method?.startsWith('item/reasoning/')) {
    const key = itemId ?? turnId
    return {
      kind: 'thinking',
      text: event.data,
      ...(key ? { key: `reasoning:${method}:${key}`, mode: 'append' as const } : {}),
    }
  }

  if (method && TOOL_OUTPUT_METHODS.has(method)) {
    const key = itemId ?? turnId
    return {
      kind: 'tool_result',
      text: event.data,
      ...(key ? { key: `tool-output:${key}`, mode: 'append' as const } : {}),
    }
  }

  if ((method === 'item/started' || method === 'item/completed') && itemId && event.type === 'tool') {
    return { kind: 'tool', text: event.data, key: `tool:${itemId}`, mode: 'replace' }
  }

  const kind: DriverTranscriptKind = event.type === 'error' ? 'error'
    : event.type === 'tool' ? 'tool'
      : event.type === 'output' ? 'text' : 'status'
  return { kind, text: event.data }
}

/**
 * Project a provider event into the human transcript while keeping the raw driver
 * event stream free to remain lossless for persistence, accounting, and debugging.
 */
export function appendDriverTranscript(
  lines: DriverTranscriptLine[],
  event: DriverEvent,
  limit = 500,
): boolean {
  const next = presentation(event)
  if (!next) return false
  const metadata = safeMetadata(event.metadata ?? {})
  if (next.key) metadata.transcriptKey = next.key

  if (next.key && next.mode) {
    let index = -1
    for (let cursor = lines.length - 1; cursor >= 0; cursor -= 1) {
      if (lines[cursor].kind === next.kind && lines[cursor].metadata?.transcriptKey === next.key) {
        index = cursor
        break
      }
    }
    if (index >= 0) {
      const current = lines[index]
      lines[index] = {
        at: event.at,
        kind: next.kind,
        text: next.mode === 'append' ? current.text + next.text : next.text,
        metadata: { ...(current.metadata ?? {}), ...metadata },
      }
      return true
    }
  }

  lines.push({ at: event.at, kind: next.kind, text: next.text, ...(Object.keys(metadata).length ? { metadata } : {}) })
  if (lines.length > limit) lines.splice(0, lines.length - limit)
  return true
}

export function projectDriverTranscript(events: DriverEvent[], limit = 500): DriverTranscriptLine[] {
  const lines: DriverTranscriptLine[] = []
  for (const event of events) appendDriverTranscript(lines, event, limit)
  return lines
}
