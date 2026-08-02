export const LEGACY_LAUNCH_ZERO_USAGE_MIN_DAYS = 14

export type LegacyLaunchDailyObservation = {
  utcDate: string
  sealed: boolean
  coverageComplete: boolean
  canonicalLaunches: number
  legacyLaunchWrites: number
  telemetryFailures: number
  telemetryMismatches: number
}

export type LegacyLaunchRollbackEvidence = {
  sourceCommit: string
  testedAt: string
  artifactSha256: string
  restoredCompatibilityWrites: boolean
  preservedCanonicalRows: boolean
  integrityCheckPassed: boolean
}

export type LegacyLaunchRetirementEvidence = {
  sourceCommit: string
  observationThrough: string
  daily: readonly LegacyLaunchDailyObservation[]
  rollback: LegacyLaunchRollbackEvidence | null
}

export type LegacyLaunchRetirementDecision =
  | {
      eligible: true
      reason_code: 'zero_usage_and_rollback_proven'
      observedDays: number
      canonicalLaunches: number
    }
  | {
      eligible: false
      reason_code:
        | 'source_commit_invalid'
        | 'observation_window_incomplete'
        | 'observation_window_not_consecutive'
        | 'telemetry_not_sealed'
        | 'telemetry_coverage_incomplete'
        | 'legacy_usage_observed'
        | 'telemetry_unhealthy'
        | 'canonical_launches_unobserved'
        | 'rollback_evidence_missing'
        | 'rollback_source_mismatch'
        | 'rollback_evidence_invalid'
      detail: string
    }

/**
 * ORC-020 fail-closed removal gate. Implementation or fixture evidence cannot
 * substitute for an observed, sealed production telemetry window.
 */
export function evaluateLegacyLaunchRetirement(
  evidence: LegacyLaunchRetirementEvidence,
  minimumDays = LEGACY_LAUNCH_ZERO_USAGE_MIN_DAYS,
): LegacyLaunchRetirementDecision {
  if (!/^[0-9a-f]{40}$/.test(evidence.sourceCommit)) {
    return blocked('source_commit_invalid', 'source commit must be an exact lowercase git SHA')
  }
  if (!Number.isSafeInteger(minimumDays) || minimumDays < 1) {
    throw new Error('minimumDays must be a positive integer')
  }
  const through = parseUtcDate(evidence.observationThrough)
  const ordered = [...evidence.daily].sort((left, right) => left.utcDate.localeCompare(right.utcDate))
  if (ordered.length < minimumDays) {
    return blocked('observation_window_incomplete', `at least ${minimumDays} sealed UTC days are required`)
  }
  const window = ordered.slice(-minimumDays)
  if (window.at(-1)?.utcDate !== evidence.observationThrough || !consecutive(window, through)) {
    return blocked('observation_window_not_consecutive', 'the evidence must end on observationThrough with no missing UTC day')
  }
  if (window.some((day) => !day.sealed)) {
    return blocked('telemetry_not_sealed', 'every observation day must be immutable and sealed')
  }
  if (window.some((day) => !day.coverageComplete)) {
    return blocked('telemetry_coverage_incomplete', 'every legacy launch writer must report complete coverage')
  }
  if (window.some((day) => invalidCount(day))) {
    return blocked('telemetry_unhealthy', 'telemetry counts must be non-negative safe integers')
  }
  if (window.some((day) => day.legacyLaunchWrites !== 0)) {
    return blocked('legacy_usage_observed', 'legacy launch writes were observed inside the retirement window')
  }
  if (window.some((day) => day.telemetryFailures !== 0 || day.telemetryMismatches !== 0)) {
    return blocked('telemetry_unhealthy', 'telemetry failures or canonical/legacy mismatches were observed')
  }
  const canonicalLaunches = window.reduce((sum, day) => sum + day.canonicalLaunches, 0)
  if (canonicalLaunches < 1) {
    return blocked('canonical_launches_unobserved', 'a zero-traffic window cannot prove legacy writes are unused')
  }
  if (!evidence.rollback) {
    return blocked('rollback_evidence_missing', 'a restore-tested rollback artifact is required')
  }
  if (evidence.rollback.sourceCommit !== evidence.sourceCommit) {
    return blocked('rollback_source_mismatch', 'rollback evidence belongs to a different source commit')
  }
  if (!validRollback(evidence.rollback)) {
    return blocked('rollback_evidence_invalid', 'rollback must restore compatibility writes, preserve canonical rows, and pass integrity checks')
  }
  return {
    eligible: true,
    reason_code: 'zero_usage_and_rollback_proven',
    observedDays: minimumDays,
    canonicalLaunches,
  }
}

function blocked(
  reason_code: Exclude<LegacyLaunchRetirementDecision, { eligible: true }>['reason_code'],
  detail: string,
): LegacyLaunchRetirementDecision {
  return { eligible: false, reason_code, detail }
}

function parseUtcDate(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('observationThrough must be YYYY-MM-DD')
  const date = new Date(`${value}T00:00:00.000Z`)
  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error('observationThrough must be a real UTC date')
  }
  return date
}

function consecutive(window: readonly LegacyLaunchDailyObservation[], through: Date): boolean {
  return window.every((day, index) => {
    const expected = new Date(through)
    expected.setUTCDate(through.getUTCDate() - (window.length - index - 1))
    return day.utcDate === expected.toISOString().slice(0, 10)
  })
}

function invalidCount(day: LegacyLaunchDailyObservation): boolean {
  return [day.canonicalLaunches, day.legacyLaunchWrites, day.telemetryFailures, day.telemetryMismatches]
    .some((value) => !Number.isSafeInteger(value) || value < 0)
}

function validRollback(rollback: LegacyLaunchRollbackEvidence): boolean {
  return !Number.isNaN(Date.parse(rollback.testedAt))
    && /^[0-9a-f]{64}$/.test(rollback.artifactSha256)
    && rollback.restoredCompatibilityWrites
    && rollback.preservedCanonicalRows
    && rollback.integrityCheckPassed
}
