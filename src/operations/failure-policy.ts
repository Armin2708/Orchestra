export type OperationalFailureKind =
  | 'disk_full'
  | 'database_locked'
  | 'provider_unavailable'
  | 'git_conflict'
  | 'unknown'

export type OperationalFailureSource = 'storage' | 'database' | 'provider' | 'workspace'

export interface OperationalFailurePolicy {
  mutation: 'fail_closed' | 'bounded_retry' | 'bounded_queue' | 'block_job'
  reads: 'continue_safe_reads' | 'best_effort' | 'unavailable'
  retry_limit: number
  retry_window_ms: number
  alert_severity: 'warning' | 'critical'
  reason_code: string
}

export const OPERATIONS_FAILURE_POLICIES: Readonly<Record<OperationalFailureKind, OperationalFailurePolicy>> =
  Object.freeze({
    disk_full: Object.freeze({
      mutation: 'fail_closed', reads: 'continue_safe_reads', retry_limit: 0, retry_window_ms: 0,
      alert_severity: 'critical', reason_code: 'storage_capacity_exhausted',
    }),
    database_locked: Object.freeze({
      mutation: 'bounded_retry', reads: 'best_effort', retry_limit: 3, retry_window_ms: 2_000,
      alert_severity: 'warning', reason_code: 'database_lock_contention',
    }),
    provider_unavailable: Object.freeze({
      mutation: 'bounded_queue', reads: 'continue_safe_reads', retry_limit: 5, retry_window_ms: 60_000,
      alert_severity: 'warning', reason_code: 'provider_temporarily_unavailable',
    }),
    git_conflict: Object.freeze({
      mutation: 'block_job', reads: 'continue_safe_reads', retry_limit: 0, retry_window_ms: 0,
      alert_severity: 'warning', reason_code: 'workspace_git_conflict',
    }),
    unknown: Object.freeze({
      mutation: 'fail_closed', reads: 'unavailable', retry_limit: 0, retry_window_ms: 0,
      alert_severity: 'critical', reason_code: 'unclassified_operational_failure',
    }),
  })

/** Classifies only stable platform/provider error codes; raw messages never enter logs. */
export function classifyOperationalFailure(
  error: unknown,
  source?: OperationalFailureSource,
): OperationalFailureKind {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code).toUpperCase()
    : ''
  if ((source === 'storage' || source === 'database')
    && (code === 'ENOSPC' || code === 'SQLITE_FULL')) return 'disk_full'
  if (source === 'database'
    && (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED' || code === 'EBUSY')) return 'database_locked'
  if (source === 'provider'
    && (code === 'PROVIDER_UNAVAILABLE' || code === 'ECONNREFUSED' || code === 'ETIMEDOUT')) {
    return 'provider_unavailable'
  }
  if (source === 'workspace'
    && (code === 'GIT_CONFLICT' || code === 'WORKTREE_CONFLICT')) return 'git_conflict'
  return 'unknown'
}
