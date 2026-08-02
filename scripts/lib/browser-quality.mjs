import { createHash } from 'node:crypto'

export const BROWSER_QUALITY_SCHEMA_VERSION = 1

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

// Budgets are deliberately derived from a checked observation. The additive floor
// absorbs timer/CI scheduling noise; the multiplier catches material regressions.
export const deriveBudgetMs = (observedP95Ms, { multiplier = 4, additiveMs = 100 } = {}) => {
  if (!Number.isFinite(observedP95Ms) || observedP95Ms <= 0) {
    throw new Error('observed p95 must be a positive finite number')
  }
  return Math.ceil(Math.max(observedP95Ms * multiplier, observedP95Ms + additiveMs))
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

export const validateBrowserQualityEvidence = (evidence) => {
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
    for (const surface of PERFORMANCE_SURFACES) {
      const result = actual.performance?.[surface]
      if (!result || !Number.isFinite(result.observed_ms) || result.observed_ms < 0) {
        errors.push(`${expected.id} is missing ${surface} performance evidence`)
      } else if (Number.isFinite(result.budget_ms) && result.observed_ms > result.budget_ms) {
        errors.push(`${expected.id} exceeded ${surface} budget`)
      }
    }
  }
  if (canonicalJson(evidence) !== canonicalJson(redactEvidence(evidence))) {
    errors.push('evidence contains secret-shaped fields or values')
  }
  return errors
}
