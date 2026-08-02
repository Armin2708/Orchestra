import { createHash } from 'node:crypto'
import { lstatSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'

export const BROWSER_QUALITY_SCHEMA_VERSION = 3
export const BROWSER_BASELINE_SCHEMA_VERSION = 3
export const BROWSER_BUILD_SCHEMA_VERSION = 2

export const RESPONSIVE_VIEWPORTS = Object.freeze([
  Object.freeze({ id: 'desktop', width: 1440, height: 1000, mobile: false }),
  Object.freeze({ id: 'tablet', width: 834, height: 1194, mobile: true }),
  Object.freeze({ id: 'phone', width: 390, height: 844, mobile: true }),
])

export const ACCESSIBILITY_GATES = Object.freeze([
  'accessible_names',
  'keyboard_focus',
  'screen_reader_tree',
  'text_contrast',
])

export const PERFORMANCE_SURFACES = Object.freeze([
  'startup',
  'snapshot_loading',
  'transcript_loading',
  'graph_view',
  'search',
])

export const BETA_EXPERIENCE_BUDGETS_MS = Object.freeze({
  startup: 1_500,
  snapshot_loading: 3_000,
  transcript_loading: 3_500,
  graph_view: 1_000,
  search: 750,
})

const secretKey = /(?:authorization|cookie|password|secret|token|credential|session[_-]?token|api[_-]?key)/i
const bearer = /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi
const secretAssignment = /\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY))\s*=\s*([^\s,;]+)/gi
const urlCredential = /([?&](?:token|key|secret|password|credential)=)[^&#\s]*/gi

export const redactText = (value) => String(value)
  .replace(bearer, 'Bearer [REDACTED]')
  .replace(secretAssignment, '$1=[REDACTED]')
  .replace(urlCredential, '$1[REDACTED]')

export const redactEvidence = (value, key = '') => {
  if (secretKey.test(key)) return '[REDACTED]'
  if (typeof value === 'string') return redactText(value)
  if (Array.isArray(value)) return value.map((item) => redactEvidence(item))
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [
    entryKey,
    redactEvidence(entryValue, entryKey),
  ]))
}

export const canonicalJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export const evidenceDigest = (value) => createHash('sha256')
  .update(canonicalJson(redactEvidence(value)))
  .digest('hex')

export const verifiableDocumentDigest = (value) => {
  const document = structuredClone(value)
  delete document.sha256
  delete document.validation_errors
  return evidenceDigest(document)
}

export const percentile = (samples, quantile) => {
  if (!Array.isArray(samples) || samples.length === 0) throw new Error('samples must not be empty')
  const sorted = samples.map(Number).filter(Number.isFinite).sort((left, right) => left - right)
  if (sorted.length !== samples.length) throw new Error('samples must contain finite numbers')
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1))
  return sorted[index]
}

export const summarizeSamples = (samples) => {
  const values = samples.map(Number)
  return {
    samples: values.length,
    min: Math.min(...values),
    mean: values.reduce((sum, value) => sum + value, 0) / values.length,
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    max: Math.max(...values),
  }
}

// A checked observation provides a regression bound, while the explicit beta
// experience ceiling prevents a slow observation from normalizing poor UX.
export const deriveRegressionBudgetMs = (observedP95Ms, { multiplier = 2, additiveMs = 150 } = {}) => {
  if (!Number.isFinite(observedP95Ms) || observedP95Ms <= 0) {
    throw new Error('observed p95 must be a positive finite number')
  }
  return Math.ceil(Math.max(observedP95Ms * multiplier, observedP95Ms + additiveMs))
}

export const checkedBudget = (surface, observedP95Ms) => {
  const experienceBudget = BETA_EXPERIENCE_BUDGETS_MS[surface]
  if (!Number.isFinite(experienceBudget)) throw new Error(`unknown performance surface: ${surface}`)
  const regressionBudget = deriveRegressionBudgetMs(observedP95Ms)
  return {
    budget_ms: Math.min(experienceBudget, regressionBudget),
    experience_budget_ms: experienceBudget,
    regression_budget_ms: regressionBudget,
    budget_source: 'checked_observation',
  }
}

export const performanceSampleForJourney = (interactionModes) => {
  const pointer = interactionModes?.pointer
  const fallback = interactionModes?.dom_fallback
  if (!Number.isFinite(pointer?.elapsed_ms) || pointer.elapsed_ms < 0) {
    throw new Error('pointer interaction is missing a finite performance sample')
  }
  if (pointer.performance_eligible !== true) {
    throw new Error('pointer interaction is not performance eligible')
  }
  if (fallback?.performance_eligible !== false || fallback?.diagnostic_only !== true) {
    throw new Error('DOM fallback must remain diagnostic-only and performance-ineligible')
  }
  return pointer.elapsed_ms
}

export const validateBuildSourceIdentity = (manifest, current) => {
  const errors = []
  if (manifest?.source_status !== 'clean') errors.push('build manifest source status is not clean')
  if (current?.source_status !== 'clean') errors.push('tracked source tree is dirty')
  if (manifest?.source_commit !== current?.source_commit) errors.push('build manifest source commit is stale')
  if (!/^[a-f0-9]{64}$/.test(String(manifest?.source_tree_sha256 ?? ''))
    || manifest.source_tree_sha256 !== current?.source_tree_sha256) errors.push('build manifest source-tree digest is stale')
  if (!(Date.parse(manifest?.artifacts_built_at) >= Date.parse(manifest?.source_checked_at))) {
    errors.push('build artifacts were not produced after the clean-source check')
  }
  return errors
}

export const resolveApprovedEvidencePath = (repositoryRoot, value) => {
  if (typeof value !== 'string' || !value || isAbsolute(value)) throw new Error('capture path must be repository-relative')
  const realRepository = realpathSync(repositoryRoot)
  const approved = realpathSync(resolve(realRepository, 'docs', 'qa-evidence', 'browser-quality'))
  const lexical = resolve(realRepository, value)
  const actual = realpathSync(lexical)
  if (lstatSync(lexical).isSymbolicLink() || actual !== lexical) throw new Error('capture path may not use symlinks')
  const child = relative(approved, actual)
  if (!child || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error('capture path is outside the approved evidence directory')
  }
  return actual
}

const parseRgb = (value) => {
  const match = String(value).match(/^rgba?\(\s*([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/i)
  if (!match) return null
  return {
    red: Number(match[1]),
    green: Number(match[2]),
    blue: Number(match[3]),
    alpha: match[4] === undefined ? 1 : Number(match[4]),
  }
}

const luminanceChannel = (value) => {
  const normalized = value / 255
  return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
}

export const contrastRatio = (foreground, background) => {
  const fg = parseRgb(foreground)
  const bg = parseRgb(background)
  if (!fg || !bg || fg.alpha !== 1 || bg.alpha !== 1) return null
  const luminance = (color) => 0.2126 * luminanceChannel(color.red)
    + 0.7152 * luminanceChannel(color.green)
    + 0.0722 * luminanceChannel(color.blue)
  const light = Math.max(luminance(fg), luminance(bg))
  const dark = Math.min(luminance(fg), luminance(bg))
  return (light + 0.05) / (dark + 0.05)
}

export const validatePerformanceBaseline = (baseline) => {
  const errors = []
  if (baseline?.schema_version !== BROWSER_BASELINE_SCHEMA_VERSION) errors.push('baseline schema version is invalid')
  if (baseline?.status !== 'checked_observation') errors.push('baseline status must be checked_observation')
  if (baseline?.budget_source !== 'checked_observation') errors.push('baseline budget_source must be checked_observation')
  if (!/^[a-f0-9]{40}$/.test(String(baseline?.source?.commit ?? ''))) errors.push('baseline source commit is invalid')
  for (const key of ['root_dist_sha256', 'web_dist_sha256']) {
    if (!/^[a-f0-9]{64}$/.test(String(baseline?.source?.artifact_identity?.[key] ?? ''))) {
      errors.push(`baseline artifact identity ${key} is invalid`)
    }
  }
  if (!/^[a-f0-9]{64}$/.test(String(baseline?.sha256 ?? '')) || baseline.sha256 !== verifiableDocumentDigest(baseline)) {
    errors.push('baseline digest is invalid')
  }
  const captures = Array.isArray(baseline?.capture_artifacts) ? baseline.capture_artifacts : []
  if (captures.length < 3) errors.push('baseline requires at least three retained capture artifacts')
  for (const capture of captures) {
    if (typeof capture?.path !== 'string' || !capture.path || !/^[a-f0-9]{64}$/.test(String(capture?.sha256 ?? ''))) {
      errors.push('baseline capture artifact identity is invalid')
    }
  }
  const viewports = Array.isArray(baseline?.viewports) ? baseline.viewports : []
  for (const expected of RESPONSIVE_VIEWPORTS) {
    const actual = viewports.find((viewport) => viewport.id === expected.id)
    if (!actual || actual.width !== expected.width || actual.height !== expected.height) {
      errors.push(`baseline is missing exact ${expected.id} viewport`)
      continue
    }
    for (const surface of PERFORMANCE_SURFACES) {
      const metric = actual.performance?.[surface]
      if (!metric || !Array.isArray(metric.samples_ms) || metric.samples_ms.length < 3
        || metric.samples_ms.some((sample) => !Number.isFinite(sample) || sample < 0)) {
        errors.push(`baseline ${expected.id} ${surface} samples are invalid`)
        continue
      }
      if (!Number.isFinite(metric.observed_p95_ms) || metric.observed_p95_ms <= 0) {
        errors.push(`baseline ${expected.id} ${surface} p95 is invalid`)
      }
      if (!Number.isFinite(metric.budget_ms) || metric.budget_ms <= 0) {
        errors.push(`baseline ${expected.id} ${surface} budget_ms is invalid`)
      }
      if (metric.budget_source !== 'checked_observation') {
        errors.push(`baseline ${expected.id} ${surface} budget source is invalid`)
      }
      const expectedMode = surface === 'startup' ? 'navigation_timing'
        : surface === 'snapshot_loading' ? 'authenticated_fetch' : 'pointer'
      if (metric.measurement_mode !== expectedMode) {
        errors.push(`baseline ${expected.id} ${surface} measurement mode is invalid`)
      }
      const expectedBudget = checkedBudget(surface, metric.observed_p95_ms)
      for (const key of ['budget_ms', 'experience_budget_ms', 'regression_budget_ms']) {
        if (metric[key] !== expectedBudget[key]) errors.push(`baseline ${expected.id} ${surface} ${key} is invalid`)
      }
    }
  }
  return errors
}

export const validateBaselineAgainstCaptures = (baseline, captures) => {
  const errors = []
  if (!Array.isArray(captures) || captures.length < 3) return ['at least three capture documents are required']
  const sourceCommit = baseline?.source?.commit
  const artifactIdentity = baseline?.source?.artifact_identity
  for (const [index, capture] of captures.entries()) {
    if (capture?.source?.commit !== sourceCommit) errors.push(`capture ${index + 1} source commit differs from baseline`)
    if (canonicalJson(capture?.source?.artifact_identity) !== canonicalJson(artifactIdentity)) {
      errors.push(`capture ${index + 1} artifact identity differs from baseline`)
    }
  }
  for (const viewport of RESPONSIVE_VIEWPORTS) {
    const claimed = baseline?.viewports?.find((candidate) => candidate.id === viewport.id)
    for (const surface of PERFORMANCE_SURFACES) {
      const samples = captures.map((capture) => capture?.viewports
        ?.find((candidate) => candidate.id === viewport.id)?.performance?.[surface]?.observed_ms)
      if (samples.some((sample) => !Number.isFinite(sample) || sample < 0)) {
        errors.push(`captures are missing ${viewport.id} ${surface} samples`)
        continue
      }
      const recomputedP95 = percentile(samples, 0.95)
      const recomputedBudget = checkedBudget(surface, recomputedP95)
      const metric = claimed?.performance?.[surface]
      const expectedMode = surface === 'startup' ? 'navigation_timing'
        : surface === 'snapshot_loading' ? 'authenticated_fetch' : 'pointer'
      if (canonicalJson(metric?.samples_ms) !== canonicalJson(samples)) errors.push(`baseline ${viewport.id} ${surface} samples do not match captures`)
      if (metric?.observed_p95_ms !== recomputedP95) errors.push(`baseline ${viewport.id} ${surface} p95 does not match captures`)
      if (metric?.measurement_mode !== expectedMode) errors.push(`baseline ${viewport.id} ${surface} measurement mode does not match captures`)
      for (const key of ['budget_ms', 'experience_budget_ms', 'regression_budget_ms', 'budget_source']) {
        if (metric?.[key] !== recomputedBudget[key]) errors.push(`baseline ${viewport.id} ${surface} ${key} does not match captures`)
      }
    }
  }
  return errors
}

export const validateBrowserQualityEvidence = (evidence, { requireBudgets = true } = {}) => {
  const errors = []
  if (evidence?.schema_version !== BROWSER_QUALITY_SCHEMA_VERSION) errors.push('schema version is invalid')
  const viewports = Array.isArray(evidence?.viewports) ? evidence.viewports : []
  for (const expected of RESPONSIVE_VIEWPORTS) {
    const actual = viewports.find((viewport) => viewport.id === expected.id)
    if (!actual) {
      errors.push(`missing ${expected.id} viewport`)
      continue
    }
    if (actual.width !== expected.width || actual.height !== expected.height) {
      errors.push(`${expected.id} viewport dimensions changed`)
    }
    if (actual.horizontal_overflow_px > 0) errors.push(`${expected.id} has horizontal overflow`)
    if (actual.console_errors?.length) errors.push(`${expected.id} emitted console errors`)
    if (actual.page_errors?.length) errors.push(`${expected.id} emitted page errors`)
    if (actual.failed_requests?.length) errors.push(`${expected.id} has failed requests`)
    for (const gate of ACCESSIBILITY_GATES) {
      if (actual.accessibility?.[gate]?.passed !== true) errors.push(`${expected.id} failed ${gate}`)
    }
    if (actual.readiness?.graph_agents_rendered !== 18) errors.push(`${expected.id} did not render all 18 graph agents`)
    if (actual.readiness?.transcript_events_rendered < 250) errors.push(`${expected.id} did not render 250 transcript events`)
    if (actual.readiness?.search_matches_rendered !== 5) errors.push(`${expected.id} did not render the five expected search matches`)
    if (actual.journeys?.length !== 12 || actual.journeys.some((journey) => !journey.accessibility)) {
      errors.push(`${expected.id} is missing per-journey accessibility evidence`)
    }
    for (const journey of actual.journeys ?? []) {
      for (const mode of ['pointer', 'keyboard']) {
        if (journey.interaction_modes?.[mode]?.passed !== true) errors.push(`${expected.id} ${journey.name} failed independent ${mode} interaction`)
      }
      if (!journey.interaction_modes?.dom_fallback || journey.interaction_modes.dom_fallback.counts_toward_pass !== false) {
        errors.push(`${expected.id} ${journey.name} is missing separately labeled DOM fallback evidence`)
      }
      if (journey.performance_sample_mode !== 'pointer'
        || journey.elapsed_ms !== journey.interaction_modes?.pointer?.elapsed_ms
        || journey.interaction_modes?.pointer?.performance_eligible !== true
        || journey.interaction_modes?.keyboard?.performance_eligible !== false
        || journey.interaction_modes?.dom_fallback?.performance_eligible !== false
        || journey.interaction_modes?.dom_fallback?.diagnostic_only !== true) {
        errors.push(`${expected.id} ${journey.name} has invalid performance-mode attribution`)
      }
      if (journey.name === 'conversation search'
        && (journey.interaction_modes?.keyboard?.action_evidence?.focus_acquisition !== 'tab_navigation'
          || !Number.isInteger(journey.interaction_modes.keyboard.action_evidence.tab_events)
          || journey.interaction_modes.keyboard.action_evidence.tab_events < 1)) {
        errors.push(`${expected.id} conversation search lacks keyboard-only focus acquisition evidence`)
      }
    }
    const expectedMeasurementModes = {
      startup: 'navigation_timing',
      snapshot_loading: 'authenticated_fetch',
      transcript_loading: 'pointer',
      graph_view: 'pointer',
      search: 'pointer',
    }
    for (const surface of PERFORMANCE_SURFACES) {
      const result = actual.performance?.[surface]
      if (!result || !Number.isFinite(result.observed_ms) || result.observed_ms < 0) {
        errors.push(`${expected.id} is missing ${surface} performance evidence`)
      } else if (requireBudgets && (!Number.isFinite(result.budget_ms) || result.budget_ms <= 0
        || result.budget_source !== 'checked_observation')) {
        errors.push(`${expected.id} has invalid ${surface} budget provenance`)
      } else if (requireBudgets && result.observed_ms > result.budget_ms) {
        errors.push(`${expected.id} exceeded ${surface} budget`)
      }
      if (result?.measurement_mode !== expectedMeasurementModes[surface]) {
        errors.push(`${expected.id} ${surface} has invalid performance measurement mode`)
      }
    }
  }
  if (!/^[a-f0-9]{64}$/.test(String(evidence?.source?.artifact_identity?.root_dist_sha256 ?? ''))
    || !/^[a-f0-9]{64}$/.test(String(evidence?.source?.artifact_identity?.web_dist_sha256 ?? ''))) {
    errors.push('evidence is missing build artifact identity')
  }
  if (!/^[a-f0-9]{40}$/.test(String(evidence?.source?.commit ?? ''))) errors.push('evidence source commit is invalid')
  if (!/^[a-f0-9]{64}$/.test(String(evidence?.sha256 ?? '')) || evidence.sha256 !== verifiableDocumentDigest(evidence)) {
    errors.push('evidence digest is invalid')
  }
  if (canonicalJson(evidence) !== canonicalJson(redactEvidence(evidence))) {
    errors.push('evidence contains secret-shaped fields or values')
  }
  return errors
}
