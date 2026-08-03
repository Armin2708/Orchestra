import { createHash } from 'node:crypto'
import {
  closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, realpathSync,
  renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  LOCAL_OWNER_CHALLENGE_DIGESTS,
  LOCAL_OWNER_CHALLENGE_PATHS,
  REQUIRED_LOCAL_OWNER_CHALLENGE_PATHS,
} from './browser-auth-challenges.mjs'

export const BROWSER_QUALITY_SCHEMA_VERSION = 6
export const BROWSER_BASELINE_SCHEMA_VERSION = 4
export const BROWSER_BUILD_SCHEMA_VERSION = 3

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

export const BROWSER_JOURNEYS = Object.freeze([
  'graph overview',
  'durable transcript',
  'conversation search',
  'work command center view',
  'discussions command center view',
  'knowledge command center view',
  'outcomes command center view',
  'activity command center view',
  'Organization primary view',
  'Roadmap primary view',
  'Settings primary view',
  'Command center primary view',
])

export const BROWSER_INTERACTION_MODES = Object.freeze(['pointer', 'keyboard', 'dom_fallback'])
export const EXPECTED_BROWSER_LOGIN_CYCLES = 1 + BROWSER_JOURNEYS.length * BROWSER_INTERACTION_MODES.length

export const EVIDENCE_MAX_STRING_LENGTH = 1_024
export const EVIDENCE_MAX_ARRAY_LENGTH = 25
export const EVIDENCE_MAX_DEPTH = 12
export const EVIDENCE_MAX_BYTES = 512 * 1_024

export const AUTHENTICATED_DATA_READY_SELECTOR = '.cc-shell[data-connection="live"]'
export const AUTHENTICATED_DATA_READY_EXPRESSION = `Boolean(document.querySelector('${AUTHENTICATED_DATA_READY_SELECTOR}'))`

export const BETA_EXPERIENCE_BUDGETS_MS = Object.freeze({
  startup: 1_500,
  snapshot_loading: 3_000,
  transcript_loading: 3_500,
  graph_view: 1_000,
  search: 750,
})

const secretKey = /(?:authorization|cookie|password|secret|token|credential|session[_-]?token|api[_-]?key)/i
const bearer = /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi
const secretAssignment = /\b((?:[A-Z][A-Z0-9_-]*_)?(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|API[_-]?KEY|COOKIE|AUTHORIZATION))\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,;&#]+)/gi
const urlCredential = /([?&](?:token|key|secret|password|credential)=)[^&#\s]*/gi
const urlUserInfo = /\b(https?:\/\/)[^@\s/]+@/gi

export const redactText = (value) => String(value)
  .replace(bearer, 'Bearer [REDACTED]')
  .replace(secretAssignment, '$1=[REDACTED]')
  .replace(urlCredential, '$1[REDACTED]')
  .replace(urlUserInfo, '$1[REDACTED]@')

export const redactEvidence = (value, key = '', depth = 0) => {
  if (secretKey.test(key)) return '[REDACTED]'
  if (depth > EVIDENCE_MAX_DEPTH) return '[TRUNCATED]'
  if (typeof value === 'string') return redactText(value).slice(0, EVIDENCE_MAX_STRING_LENGTH)
  if (Array.isArray(value)) return value.slice(0, EVIDENCE_MAX_ARRAY_LENGTH)
    .map((item) => redactEvidence(item, '', depth + 1))
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [
    entryKey,
    redactEvidence(entryValue, entryKey, depth + 1),
  ]))
}

const evidenceBoundaryViolations = (value, depth = 0) => {
  if (depth > EVIDENCE_MAX_DEPTH) return true
  if (typeof value === 'string') return value.length > EVIDENCE_MAX_STRING_LENGTH
  if (Array.isArray(value)) {
    return value.length > EVIDENCE_MAX_ARRAY_LENGTH
      || value.some((item) => evidenceBoundaryViolations(item, depth + 1))
  }
  return Boolean(value && typeof value === 'object'
    && Object.values(value).some((item) => evidenceBoundaryViolations(item, depth + 1)))
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

export const STARTUP_RESOURCE_EVIDENCE_MAX = 25
const startupRouteDigest = (path) => createHash('sha256').update(path).digest('hex')
export const STARTUP_CRITICAL_RESOURCE_ROUTE_DIGESTS = Object.freeze({
  boards: startupRouteDigest('/api/v1/boards'),
  snapshot: startupRouteDigest('/api/v1/boards/:id/snapshot'),
  jobs: startupRouteDigest('/api/v1/os/boards/:id/jobs'),
  profiles: startupRouteDigest('/api/v1/os/boards/:id/agent-profiles'),
})
export const STARTUP_COMPETITOR_RESOURCE_ROUTE_DIGESTS = Object.freeze({
  system: startupRouteDigest('/api/v1/system'),
  open_work: startupRouteDigest('/api/v1/os/open-work'),
  device_self: startupRouteDigest('/api/v1/os/devices/self'),
})

export const verifiableDocumentDigest = (value) => {
  const document = structuredClone(value)
  delete document.sha256
  // Historical schema-3 observations excluded their diagnostic error list.
  // Schema-4 evidence binds the exact gate outcome and retained errors.
  if (document.schema_version === 3) delete document.validation_errors
  return evidenceDigest(document)
}

export const finalizeBrowserEvidence = (value, validationErrors, status) => {
  const document = structuredClone(value)
  const errors = redactEvidence(Array.isArray(validationErrors) ? validationErrors : [])
  document.validation_errors = errors
  document.gate_result = {
    status: status ?? (errors.length ? 'failed' : 'passed'),
    validation_error_count: errors.length,
    validation_errors_sha256: evidenceDigest(errors),
  }
  document.sha256 = verifiableDocumentDigest(document)
  return document
}

export const finalizeValidatedBrowserEvidence = (value, validator) => {
  const draft = finalizeBrowserEvidence(value, [])
  const errors = validator(draft)
  const document = finalizeBrowserEvidence(value, errors)
  const consistencyErrors = validator(document)
  if (canonicalJson(consistencyErrors) !== canonicalJson(errors)) {
    throw new Error('browser evidence validation changed during gate-result finalization')
  }
  return document
}

export const assertFinalBuildManifest = (initial, final) => {
  if (!initial || !final || initial.sha256 !== final.sha256
    || canonicalJson(initial.artifact_identity) !== canonicalJson(final.artifact_identity)) {
    throw new Error('build manifest or artifact identity changed during browser verification')
  }
}

export const navigateFreshInteractionMode = async ({ client, url, waitForReady, name, mode }) => {
  const navigation = await client.send('Page.navigate', { url })
  if (navigation?.errorText || !navigation?.loaderId) {
    throw new Error(`${name} ${mode} fresh navigation did not create a loader`)
  }
  await waitForReady()
  return {
    strategy: 'fresh_page_navigation',
    loader_sha256: createHash('sha256').update(navigation.loaderId).digest('hex'),
  }
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
  if (pointer.passed !== true) {
    throw new Error('failed pointer interaction cannot become a performance sample')
  }
  if (fallback?.performance_eligible !== false || fallback?.diagnostic_only !== true) {
    throw new Error('DOM fallback must remain diagnostic-only and performance-ineligible')
  }
  return pointer.elapsed_ms
}

export const compactJourneyEvidence = (journey) => ({
  name: journey.name,
  passed: journey.passed,
  elapsed_ms: journey.elapsed_ms,
  performance_sample_mode: journey.performance_sample_mode,
  horizontal_overflow_px: journey.horizontal_overflow_px,
  ...(journey.horizontal_overflow_px > 0 ? { overflow_measurement: journey.overflow_measurement } : {}),
  interaction_modes: Object.fromEntries(Object.entries(journey.interaction_modes ?? {}).map(([mode, result]) => {
    const compact = {
      passed: result.passed,
      elapsed_ms: result.elapsed_ms,
      counts_toward_pass: result.counts_toward_pass,
      performance_eligible: result.performance_eligible,
      diagnostic_only: result.diagnostic_only,
      reset: result.reset,
    }
    if (mode === 'keyboard' && result.action_evidence) {
      compact.action_evidence = Object.fromEntries([
        'focus_acquisition', 'programmatic_focus', 'tab_events', 'arrow_events',
        'xterm_focus_encounters', 'xterm_escape_paths', 'activation_key',
      ].filter((key) => result.action_evidence[key] !== undefined)
        .map((key) => [key, result.action_evidence[key]]))
    }
    if (result.passed !== true) {
      compact.error = result.error
      compact.setup_error = result.setup_error
      compact.action_evidence = result.action_evidence
      compact.readiness_asserted = result.readiness_asserted
      compact.input_surface = result.input_surface
    }
    return [mode, compact]
  })),
  accessibility: Object.fromEntries(Object.entries(journey.accessibility ?? {}).map(([gate, result]) => [gate, {
    passed: result.passed,
    ...(result.checked !== undefined ? { checked: result.checked } : {}),
    ...(gate === 'keyboard_focus' && Array.isArray(result.xterm_escape_paths)
      ? { xterm_escape_paths: result.xterm_escape_paths.slice(0, EVIDENCE_MAX_ARRAY_LENGTH) } : {}),
    ...(gate === 'keyboard_focus' && result.xterm_focus_encounters !== undefined
      ? { xterm_focus_encounters: result.xterm_focus_encounters } : {}),
    ...(result.passed === true ? {} : {
      violations: result.violations ?? [],
      unsupported: result.unsupported ?? [],
      unsupported_count: result.unsupported_count,
    }),
  }])),
})

export const validateBuildSourceIdentity = (manifest, current) => {
  const errors = []
  if (typeof manifest?.repository !== 'string' || !manifest.repository
    || manifest.repository !== current?.repository) errors.push('build manifest repository identity is stale')
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

export const validateArtifactIdentity = (manifest, actual) => {
  const errors = []
  for (const key of ['root_dist_sha256', 'web_dist_sha256']) {
    if (!/^[a-f0-9]{64}$/.test(String(manifest?.artifact_identity?.[key] ?? ''))
      || manifest.artifact_identity[key] !== actual?.[key]) {
      errors.push(`build artifact ${key} digest is stale`)
    }
  }
  return errors
}

export const canonicalRepositoryName = (gitCommonDirectory) => {
  const canonical = resolve(gitCommonDirectory)
  return basename(canonical) === '.git' ? basename(dirname(canonical)) : basename(canonical)
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

export const resolveApprovedArtifactPath = (repositoryRoot, value) => {
  if (typeof value !== 'string' || !value) throw new Error('artifact path is required')
  const lexicalRepository = resolve(repositoryRoot)
  const realRepository = realpathSync(repositoryRoot)
  const approved = resolve(realRepository, 'artifacts', 'qa', 'browser-quality')
  const requested = resolve(lexicalRepository, value)
  const canonicalChild = relative(realRepository, requested)
  const requestedChild = isAbsolute(value)
    && canonicalChild !== '..' && !canonicalChild.startsWith(`..${sep}`) && !isAbsolute(canonicalChild)
    ? canonicalChild
    : relative(lexicalRepository, requested)
  if (requestedChild === '..' || requestedChild.startsWith(`..${sep}`) || isAbsolute(requestedChild)) {
    throw new Error('artifact path is outside the repository')
  }
  const lexical = resolve(realRepository, requestedChild)
  const child = relative(approved, lexical)
  if (!child || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error('artifact path is outside the approved browser-quality directory')
  }
  const repositoryChild = relative(realRepository, lexical)
  let current = realRepository
  for (const component of repositoryChild.split(sep)) {
    current = resolve(current, component)
    if (!existsSync(current)) continue
    const stat = lstatSync(current)
    if (stat.isSymbolicLink()) throw new Error('artifact path may not use symlink components')
    if (current !== lexical && !stat.isDirectory()) throw new Error('artifact path parent is not a directory')
    if (current === lexical && !stat.isFile()) throw new Error('existing artifact target is not a regular file')
  }
  if (existsSync(approved) && realpathSync(approved) !== approved) {
    throw new Error('approved artifact directory is not canonical')
  }
  return lexical
}

export const assertDistinctArtifactPaths = (left, right) => {
  const leftPath = resolve(left)
  const rightPath = resolve(right)
  const caseFoldAlias = leftPath.toLocaleLowerCase('en-US') === rightPath.toLocaleLowerCase('en-US')
  const fileIdentityAlias = existsSync(leftPath) && existsSync(rightPath)
    && (() => {
      const leftStat = statSync(leftPath)
      const rightStat = statSync(rightPath)
      return leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino
    })()
  if (leftPath === rightPath || caseFoldAlias || fileIdentityAlias) {
    throw new Error('browser evidence output and build manifest must resolve to distinct files')
  }
}

export const writeBrowserArtifact = (repositoryRoot, value, document) => {
  let target = resolveApprovedArtifactPath(repositoryRoot, value)
  mkdirSync(dirname(target), { recursive: true })
  target = resolveApprovedArtifactPath(repositoryRoot, target)
  if (realpathSync(dirname(target)) !== dirname(target)) {
    throw new Error('artifact parent directory is not canonical')
  }
  const temporary = join(
    dirname(target),
    `.${basename(target)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  )
  let descriptor
  try {
    const serialized = `${JSON.stringify(redactEvidence(document), null, 2)}\n`
    if (Buffer.byteLength(serialized) > EVIDENCE_MAX_BYTES) {
      throw new Error('browser artifact exceeds bounded retention size')
    }
    descriptor = openSync(temporary, 'wx', 0o600)
    writeFileSync(descriptor, serialized)
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    resolveApprovedArtifactPath(repositoryRoot, target)
    renameSync(temporary, target)
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
    if (existsSync(temporary)) rmSync(temporary)
  }
  return target
}

export const BROWSER_OVERFLOW_AUDIT_EXPRESSION = `(() => {
  const viewportLeft = visualViewport?.offsetLeft ?? 0;
  const viewportWidth = visualViewport?.width ?? document.documentElement.clientWidth;
  const viewportRight = viewportLeft + viewportWidth;
  const documentExtent = Math.max(
    0,
    document.documentElement.scrollWidth - document.documentElement.clientWidth,
    (document.body?.scrollWidth ?? 0) - document.documentElement.clientWidth,
  );
  const ancestorCache = new WeakMap();
  const clippedByAncestor = (element, rect) => {
    for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
      let ancestor = ancestorCache.get(parent);
      if (!ancestor) {
        ancestor = { overflow_x: getComputedStyle(parent).overflowX, rect: parent.getBoundingClientRect() };
        ancestorCache.set(parent, ancestor);
      }
      if (!['auto', 'scroll', 'hidden', 'clip'].includes(ancestor.overflow_x)) continue;
      if (rect.right > ancestor.rect.right + .5 || rect.left < ancestor.rect.left - .5) return true;
    }
    return false;
  };
  const clippedByOwnPaint = (style) => {
    const clip = String(style.clip || '').replace(/\\s+/g, '').toLowerCase();
    const clipPath = String(style.clipPath || '').replace(/\\s+/g, '').toLowerCase();
    return clip === 'rect(0px,0px,0px,0px)' || clip === 'rect(0,0,0,0)'
      || clipPath === 'inset(50%)' || clipPath === 'inset(100%)';
  };
  const offenders = [], excluded = [];
  let visibleOverflow = 0, offenderCount = 0, excludedCount = 0;
  for (const element of document.querySelectorAll('body *')) {
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0 || rect.bottom <= 0 || rect.top >= innerHeight) continue;
    if (rect.right <= viewportRight + .5 && rect.left >= viewportLeft - .5) continue;
    const style = getComputedStyle(element);
    const rendered = typeof element.checkVisibility === 'function'
      ? element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
      : style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0;
    if (!rendered) continue;
    const row = {
      tag: element.tagName.toLowerCase(), id: element.id || null,
      class_name: String(element.className || '').slice(0, 120),
      left: Math.round(rect.left), right: Math.round(rect.right), width: Math.round(rect.width),
    };
    if (clippedByOwnPaint(style)) {
      excludedCount += 1;
      if (excluded.length < 25) excluded.push({ ...row, reason: 'own_zero_area_paint_clip' });
      continue;
    }
    if (clippedByAncestor(element, rect)) {
      excludedCount += 1;
      if (excluded.length < 25) excluded.push({ ...row, reason: 'contained_horizontal_scroller_or_clip' });
      continue;
    }
    offenderCount += 1;
    visibleOverflow = Math.max(visibleOverflow, row.right - viewportRight, viewportLeft - row.left);
    if (offenders.length < 25) offenders.push(row);
  }
  return {
    visible_overflow_px: Math.max(0, Math.ceil(visibleOverflow)),
    document_extent_overflow_px: Math.ceil(documentExtent),
    offender_count: offenderCount,
    excluded_count: excludedCount,
    offenders,
    excluded_nonvisual_or_contained: excluded,
  };
})()`

export const parseRgb = (value) => {
  const match = String(value).match(/^rgba?\(\s*([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/i)
  if (!match) return null
  return {
    red: Number(match[1]),
    green: Number(match[2]),
    blue: Number(match[3]),
    alpha: match[4] === undefined ? 1 : Number(match[4]),
  }
}

export const compositeRgba = (foreground, background) => {
  const fg = typeof foreground === 'string' ? parseRgb(foreground) : foreground
  const bg = typeof background === 'string' ? parseRgb(background) : background
  if (!fg || !bg || !Number.isFinite(fg.alpha) || !Number.isFinite(bg.alpha)) return null
  const alpha = fg.alpha + bg.alpha * (1 - fg.alpha)
  if (alpha <= 0) return { red: 0, green: 0, blue: 0, alpha: 0 }
  return {
    red: (fg.red * fg.alpha + bg.red * bg.alpha * (1 - fg.alpha)) / alpha,
    green: (fg.green * fg.alpha + bg.green * bg.alpha * (1 - fg.alpha)) / alpha,
    blue: (fg.blue * fg.alpha + bg.blue * bg.alpha * (1 - fg.alpha)) / alpha,
    alpha,
  }
}

const luminanceChannel = (value) => {
  const normalized = value / 255
  return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
}

export const contrastRatio = (foreground, background) => {
  let fg = parseRgb(foreground)
  const bg = parseRgb(background)
  if (!fg || !bg || bg.alpha !== 1) return null
  if (fg.alpha !== 1) fg = compositeRgba(fg, bg)
  if (!fg || fg.alpha !== 1) return null
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
      const expectedMode = surface === 'startup' ? 'authenticated_submit_to_ready'
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
      const expectedMode = surface === 'startup' ? 'authenticated_submit_to_ready'
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
  const viewportIds = viewports.map((viewport) => viewport?.id)
  if (viewportIds.length !== RESPONSIVE_VIEWPORTS.length
    || new Set(viewportIds).size !== viewportIds.length
    || RESPONSIVE_VIEWPORTS.some((viewport) => !viewportIds.includes(viewport.id))) {
    errors.push('viewport inventory is not exact and unique')
  }
  for (const expected of RESPONSIVE_VIEWPORTS) {
    const actual = viewports.find((viewport) => viewport.id === expected.id)
    if (!actual) {
      errors.push(`missing ${expected.id} viewport`)
      continue
    }
    if (actual.width !== expected.width || actual.height !== expected.height) {
      errors.push(`${expected.id} viewport dimensions changed`)
    }
    if (!Number.isInteger(actual.horizontal_overflow_px) || actual.horizontal_overflow_px < 0
      || !Number.isInteger(actual.overflow_measurement?.visible_overflow_px)
      || actual.overflow_measurement.visible_overflow_px < 0
      || actual.overflow_measurement.visible_overflow_px !== actual.horizontal_overflow_px
      || !Number.isInteger(actual.overflow_measurement?.document_extent_overflow_px)
      || actual.overflow_measurement.document_extent_overflow_px < 0) {
      errors.push(`${expected.id} has invalid overflow measurement provenance`)
    }
    if (actual.horizontal_overflow_px > 0) errors.push(`${expected.id} has horizontal overflow`)
    if (actual.console_errors?.length) errors.push(`${expected.id} emitted console errors`)
    if (actual.page_errors?.length) errors.push(`${expected.id} emitted page errors`)
    if (actual.failed_requests?.length) errors.push(`${expected.id} has failed requests`)
    const challengeInventory = actual.authentication_challenge_inventory
    const challengeEndpoints = Array.isArray(challengeInventory?.endpoints) ? challengeInventory.endpoints : []
    const allowedChallengeDigests = new Set(Object.values(LOCAL_OWNER_CHALLENGE_DIGESTS))
    const requiredChallengeDigests = new Set(REQUIRED_LOCAL_OWNER_CHALLENGE_PATHS
      .map((path) => LOCAL_OWNER_CHALLENGE_DIGESTS[path]))
    const challengeDigests = challengeEndpoints.map((entry) => entry?.endpoint_sha256)
    const challengeCycles = challengeInventory?.login_cycles
    const challengeTotal = challengeEndpoints.reduce((sum, entry) => sum
      + (Number.isInteger(entry?.count) ? entry.count : 0), 0)
    const retainedChallenges = Array.isArray(actual.authentication_challenges)
      ? actual.authentication_challenges : []
    const validChallengeInventory = challengeInventory?.passed === true
      && challengeCycles === EXPECTED_BROWSER_LOGIN_CYCLES
      && challengeEndpoints.length === LOCAL_OWNER_CHALLENGE_PATHS.length
      && new Set(challengeDigests).size === LOCAL_OWNER_CHALLENGE_PATHS.length
      && challengeDigests.every((digest) => allowedChallengeDigests.has(digest))
      && challengeEndpoints.every((entry) => Number.isInteger(entry?.count)
        && requiredChallengeDigests.has(entry.endpoint_sha256)
        && entry.count === challengeCycles)
      && challengeInventory.total_count === challengeTotal
      && challengeTotal === 2 * challengeCycles
      && challengeInventory.pending_request_count === 0
      && retainedChallenges.length === Math.min(challengeTotal, EVIDENCE_MAX_ARRAY_LENGTH)
      && retainedChallenges.every((entry) => entry?.label === 'expected_local_owner_challenge'
        && entry.status === 401 && allowedChallengeDigests.has(entry.endpoint_sha256))
    if (!validChallengeInventory) errors.push(`${expected.id} has invalid authentication challenge inventory`)
    for (const gate of ACCESSIBILITY_GATES) {
      if (actual.accessibility?.[gate]?.passed !== true) errors.push(`${expected.id} failed ${gate}`)
    }
    if (!Number.isInteger(actual.readiness?.dependency_graph_nodes_rendered)
      || actual.readiness.dependency_graph_nodes_rendered < 1) {
      errors.push(`${expected.id} did not render the dependency graph`)
    }
    if (actual.readiness?.transcript_events_rendered < 250) errors.push(`${expected.id} did not render 250 transcript events`)
    if (actual.readiness?.search_matches_rendered !== 5) errors.push(`${expected.id} did not render the five expected search matches`)
    const journeys = Array.isArray(actual.journeys) ? actual.journeys : []
    const journeyNames = journeys.map((journey) => journey?.name)
    if (journeyNames.length !== BROWSER_JOURNEYS.length
      || new Set(journeyNames).size !== journeyNames.length
      || canonicalJson(journeyNames) !== canonicalJson(BROWSER_JOURNEYS)) {
      errors.push(`${expected.id} journey inventory is not exact and unique`)
    }
    if (journeys.length !== BROWSER_JOURNEYS.length || journeys.some((journey) => !journey.accessibility)) {
      errors.push(`${expected.id} is missing per-journey accessibility evidence`)
    }
    for (const journey of journeys) {
      const isolationIds = []
      for (const mode of BROWSER_INTERACTION_MODES) {
        if (mode !== 'dom_fallback' && journey.interaction_modes?.[mode]?.passed !== true) {
          errors.push(`${expected.id} ${journey.name} failed independent ${mode} interaction`)
        }
        const reset = journey.interaction_modes?.[mode]?.reset
        if (reset?.strategy !== 'fresh_page_navigation'
          || !/^[a-f0-9]{64}$/.test(String(reset?.loader_sha256 ?? ''))) {
          errors.push(`${expected.id} ${journey.name} ${mode} lacks fresh navigation isolation`)
        } else {
          isolationIds.push(reset.loader_sha256)
        }
      }
      if (new Set(isolationIds).size !== 3) {
        errors.push(`${expected.id} ${journey.name} interaction modes do not have unique page lifecycles`)
      }
      const keyboardEvidence = journey.interaction_modes?.keyboard?.action_evidence
      if (keyboardEvidence?.focus_acquisition !== 'tab_navigation'
        || keyboardEvidence?.programmatic_focus !== false
        || !Number.isInteger(keyboardEvidence?.tab_events)
        || keyboardEvidence.tab_events < 1) {
        errors.push(`${expected.id} ${journey.name} lacks keyboard-only activation evidence`)
      }
      const xtermEvidenceSources = [keyboardEvidence, journey.accessibility?.keyboard_focus]
      const validXtermEvidence = xtermEvidenceSources.every((source) => {
        const encounters = source?.xterm_focus_encounters
        const paths = Array.isArray(source?.xterm_escape_paths) ? source.xterm_escape_paths : []
        return Number.isInteger(encounters) && encounters >= 0
          && ((encounters === 0 && paths.length === 0) || (encounters > 0 && paths.length > 0))
          && paths.every((path) => ['Escape+Tab', 'Escape+Shift+Tab'].includes(path?.escape_path)
            && path.documented === true && path.armed === true && path.advanced === true
            && typeof path.from === 'string' && typeof path.to === 'string' && path.from !== path.to)
      })
      if (!validXtermEvidence) {
        errors.push(`${expected.id} ${journey.name} has invalid xterm keyboard escape evidence`)
      }
      if (!journey.interaction_modes?.dom_fallback || journey.interaction_modes.dom_fallback.counts_toward_pass !== false) {
        errors.push(`${expected.id} ${journey.name} is missing separately labeled DOM fallback evidence`)
      }
      const retainsPerformance = ['graph overview', 'durable transcript', 'conversation search'].includes(journey.name)
      if ((retainsPerformance && (journey.performance_sample_mode !== 'pointer'
        || journey.elapsed_ms !== journey.interaction_modes?.pointer?.elapsed_ms
        || journey.interaction_modes?.pointer?.passed !== true))
        || (!retainsPerformance && journey.performance_sample_mode !== 'diagnostic_only')
        || journey.interaction_modes?.pointer?.performance_eligible !== true
        || journey.interaction_modes?.keyboard?.performance_eligible !== false
        || journey.interaction_modes?.dom_fallback?.performance_eligible !== false
        || journey.interaction_modes?.dom_fallback?.diagnostic_only !== true) {
        errors.push(`${expected.id} ${journey.name} has invalid performance-mode attribution`)
      }
    }
    const expectedMeasurementModes = {
      startup: 'authenticated_submit_to_ready',
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
      if (typeof result?.quality_gate_passed !== 'boolean') {
        errors.push(`${expected.id} ${surface} is missing quality-linked performance status`)
      }
      if (surface === 'startup') {
        const provenance = result?.provenance
        const submitStarted = provenance?.login_form_ready_ms + provenance?.login_entry_ms
        const navigationToReady = submitStarted + provenance?.submit_to_data_ready_ms
        const commandCenterReady = submitStarted + provenance?.submit_to_command_center_ms
        const resourceTiming = provenance?.resource_timing
        const criticalResources = Array.isArray(resourceTiming?.critical_resources)
          ? resourceTiming.critical_resources : []
        const competitorResources = Array.isArray(resourceTiming?.competitor_resources)
          ? resourceTiming.competitor_resources : []
        const expectedCriticalCategories = Object.keys(STARTUP_CRITICAL_RESOURCE_ROUTE_DIGESTS)
        const exactKeys = (value, keys) => value && typeof value === 'object'
          && canonicalJson(Object.keys(value).sort()) === canonicalJson([...keys].sort())
        const validResource = (entry, routes) => exactKeys(entry, [
          'category', 'route_sha256', 'endpoint_sha256', 'start_ms', 'response_end_ms', 'duration_ms',
        ])
          && routes[entry.category] === entry.route_sha256
          && /^[a-f0-9]{64}$/.test(String(entry.endpoint_sha256 ?? ''))
          && Number.isFinite(entry.start_ms) && entry.start_ms >= submitStarted - 1
          && Number.isFinite(entry.response_end_ms) && entry.response_end_ms >= entry.start_ms
          && entry.response_end_ms <= navigationToReady + 1
          && Number.isFinite(entry.duration_ms) && entry.duration_ms >= 0
          && Math.abs(entry.duration_ms - (entry.response_end_ms - entry.start_ms)) <= 1
        const longTasks = resourceTiming?.long_tasks
        const validLongTasks = exactKeys(longTasks, [
          'supported', 'count', 'total_duration_ms', 'max_duration_ms',
        ])
          && typeof longTasks?.supported === 'boolean'
          && Number.isInteger(longTasks?.count) && longTasks.count >= 0
          && Number.isFinite(longTasks?.total_duration_ms) && longTasks.total_duration_ms >= 0
          && Number.isFinite(longTasks?.max_duration_ms) && longTasks.max_duration_ms >= 0
          && longTasks.max_duration_ms <= longTasks.total_duration_ms
          && (longTasks.count > 0 || (longTasks.total_duration_ms === 0 && longTasks.max_duration_ms === 0))
          && (longTasks.supported || longTasks.count === 0)
        const validResourceTiming = exactKeys(resourceTiming, [
          'window', 'window_start_ms', 'window_end_ms', 'critical_resource_count',
          'competitor_resource_count', 'critical_resources', 'competitor_resources', 'long_tasks',
        ])
          && resourceTiming?.window === 'submit_to_data_ready'
          && Number.isFinite(resourceTiming?.window_start_ms)
          && Math.abs(resourceTiming.window_start_ms - submitStarted) <= 1
          && Number.isFinite(resourceTiming?.window_end_ms)
          && Math.abs(resourceTiming.window_end_ms - navigationToReady) <= 1
          && Number.isInteger(resourceTiming?.critical_resource_count)
          && resourceTiming.critical_resource_count === criticalResources.length
          && criticalResources.length >= expectedCriticalCategories.length
          && criticalResources.length <= STARTUP_RESOURCE_EVIDENCE_MAX
          && expectedCriticalCategories.every((category) => criticalResources
            .some((entry) => entry?.category === category))
          && criticalResources.every((entry) => validResource(
            entry, STARTUP_CRITICAL_RESOURCE_ROUTE_DIGESTS,
          ))
          && Number.isInteger(resourceTiming?.competitor_resource_count)
          && resourceTiming.competitor_resource_count === competitorResources.length
          && competitorResources.length <= STARTUP_RESOURCE_EVIDENCE_MAX
          && competitorResources.every((entry) => validResource(
            entry, STARTUP_COMPETITOR_RESOURCE_ROUTE_DIGESTS,
          ))
          && resourceTiming?.competitor_resource_count === 0
          && validLongTasks
        if (!/^[a-f0-9]{64}$/.test(String(provenance?.loader_sha256 ?? ''))
          || !Number.isFinite(provenance?.time_origin_ms) || provenance.time_origin_ms <= 0
          || provenance?.navigation_start_ms !== 0
          || provenance?.navigation_type !== 'navigate'
          || provenance?.navigation_path !== '/'
          || provenance?.navigation_viewport !== expected.id
          || !Number.isFinite(provenance?.login_form_ready_ms) || provenance.login_form_ready_ms < 0
          || !Number.isFinite(provenance?.login_entry_ms) || provenance.login_entry_ms < 0
          || !Number.isFinite(provenance?.submit_to_command_center_ms) || provenance.submit_to_command_center_ms < 0
          || !Number.isFinite(provenance?.command_center_ready_ms) || provenance.command_center_ready_ms < 0
          || !Number.isFinite(provenance?.command_center_to_data_ready_ms) || provenance.command_center_to_data_ready_ms < 0
          || !Number.isFinite(provenance?.submit_to_data_ready_ms) || provenance.submit_to_data_ready_ms < 0
          || !Number.isFinite(provenance?.navigation_to_data_ready_ms) || provenance.navigation_to_data_ready_ms < 0
          || !Number.isFinite(provenance?.snapshot_resource_ms) || provenance.snapshot_resource_ms < 0
          || Math.abs(provenance.snapshot_resource_ms
            - actual.performance?.snapshot_loading?.observed_ms) > 1
          || provenance?.data_ready_selector !== AUTHENTICATED_DATA_READY_SELECTOR
          || Math.abs(commandCenterReady - provenance.command_center_ready_ms) > 1
          || Math.abs(navigationToReady - provenance.navigation_to_data_ready_ms) > 1
          || Math.abs(provenance.command_center_ready_ms + provenance.command_center_to_data_ready_ms
            - provenance.navigation_to_data_ready_ms) > 1
          || Math.abs(result.observed_ms - provenance.submit_to_data_ready_ms) > 1
          || !validResourceTiming) {
          errors.push(`${expected.id} has invalid startup navigation provenance`)
        }
      }
    }
  }
  const startupProvenance = viewports.map((viewport) => viewport?.performance?.startup?.provenance)
  if (new Set(startupProvenance.map((provenance) => provenance?.loader_sha256)).size !== RESPONSIVE_VIEWPORTS.length
    || new Set(startupProvenance.map((provenance) => provenance?.time_origin_ms)).size !== RESPONSIVE_VIEWPORTS.length) {
    errors.push('startup navigation provenance is not unique across viewports')
  }
  if (!/^[a-f0-9]{64}$/.test(String(evidence?.source?.artifact_identity?.root_dist_sha256 ?? ''))
    || !/^[a-f0-9]{64}$/.test(String(evidence?.source?.artifact_identity?.web_dist_sha256 ?? ''))) {
    errors.push('evidence is missing build artifact identity')
  }
  if (!/^[a-f0-9]{40}$/.test(String(evidence?.source?.commit ?? ''))) errors.push('evidence source commit is invalid')
  if (typeof evidence?.source?.repository !== 'string' || !evidence.source.repository
    || evidence?.source?.binding_status !== 'passed_preflight_and_final'
    || evidence?.source?.source_status !== 'clean'
    || !/^[a-f0-9]{64}$/.test(String(evidence?.source?.source_tree_sha256 ?? ''))
    || !/^[a-f0-9]{64}$/.test(String(evidence?.source?.build_manifest_sha256 ?? ''))) {
    errors.push('evidence source binding is incomplete')
  }
  if (!/^[a-f0-9]{64}$/.test(String(evidence?.sha256 ?? '')) || evidence.sha256 !== verifiableDocumentDigest(evidence)) {
    errors.push('evidence digest is invalid')
  }
  if (evidence?.schema_version === BROWSER_QUALITY_SCHEMA_VERSION) {
    const retainedErrors = Array.isArray(evidence.validation_errors) ? evidence.validation_errors : null
    if (!retainedErrors || !evidence?.gate_result) {
      errors.push('evidence gate result binding is missing')
    } else {
      const expectedStatus = retainedErrors.length ? 'failed' : 'passed'
      if (!['passed', 'failed'].includes(evidence.gate_result.status)
        || evidence.gate_result.status !== expectedStatus
        || evidence.gate_result.validation_error_count !== retainedErrors.length
        || evidence.gate_result.validation_errors_sha256 !== evidenceDigest(retainedErrors)) {
        errors.push('evidence gate result binding is invalid')
      }
    }
  }
  if (canonicalJson(evidence) !== canonicalJson(redactEvidence(evidence))) {
    errors.push('evidence contains secret-shaped fields or values')
  }
  if (evidenceBoundaryViolations(evidence)
    || Buffer.byteLength(canonicalJson(evidence)) > EVIDENCE_MAX_BYTES) {
    errors.push('evidence exceeds bounded retention limits')
  }
  return errors
}
