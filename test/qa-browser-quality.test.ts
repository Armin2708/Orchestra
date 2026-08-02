import { describe, expect, it } from 'vitest'
import baseline from '../docs/qa-browser-performance-baseline.json'
import observation1 from '../docs/qa-evidence/browser-quality/observation-1.json'
import observation2 from '../docs/qa-evidence/browser-quality/observation-2.json'
import observation3 from '../docs/qa-evidence/browser-quality/observation-3.json'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ACCESSIBILITY_GATES,
  BETA_EXPERIENCE_BUDGETS_MS,
  BROWSER_BASELINE_SCHEMA_VERSION,
  BROWSER_QUALITY_SCHEMA_VERSION,
  PERFORMANCE_SURFACES,
  RESPONSIVE_VIEWPORTS,
  contrastRatio,
  checkedBudget,
  deriveRegressionBudgetMs,
  evidenceDigest,
  performanceSampleForJourney,
  redactEvidence,
  resolveApprovedEvidencePath,
  validateBaselineAgainstCaptures,
  validateBuildSourceIdentity,
  validatePerformanceBaseline,
  validateBrowserQualityEvidence,
  verifiableDocumentDigest,
} from '../scripts/lib/browser-quality.mjs'

const passingEvidence = () => {
  const evidence: any = {
  schema_version: BROWSER_QUALITY_SCHEMA_VERSION,
  source: {
    commit: 'a'.repeat(40),
    artifact_identity: { root_dist_sha256: 'b'.repeat(64), web_dist_sha256: 'c'.repeat(64) },
  },
  viewports: RESPONSIVE_VIEWPORTS.map((viewport) => ({
    ...viewport,
    horizontal_overflow_px: 0,
    console_errors: [],
    page_errors: [],
    failed_requests: [],
    accessibility: Object.fromEntries(ACCESSIBILITY_GATES.map((gate) => [gate, { passed: true }])),
    readiness: { graph_agents_rendered: 18, transcript_events_rendered: 250, search_matches_rendered: 5 },
    journeys: Array.from({ length: 12 }, (_, index) => ({
      name: index === 0 ? 'conversation search' : `journey-${index}`,
      interaction_modes: {
        pointer: { passed: true, counts_toward_pass: true, elapsed_ms: 10, performance_eligible: true, diagnostic_only: false },
        keyboard: {
          passed: true, counts_toward_pass: true, elapsed_ms: 20, performance_eligible: false, diagnostic_only: false,
          action_evidence: index === 0 ? { focus_acquisition: 'tab_navigation', tab_events: 3 } : null,
        },
        dom_fallback: { passed: true, counts_toward_pass: false, elapsed_ms: 1, performance_eligible: false, diagnostic_only: true },
      },
      elapsed_ms: 10,
      performance_sample_mode: 'pointer',
      accessibility: Object.fromEntries(ACCESSIBILITY_GATES.map((gate) => [gate, { passed: true }])),
    })),
    performance: Object.fromEntries(PERFORMANCE_SURFACES.map((surface) => [surface, {
      observed_ms: 10,
      measurement_mode: surface === 'startup' ? 'navigation_timing'
        : surface === 'snapshot_loading' ? 'authenticated_fetch' : 'pointer',
      quality_gate_passed: true,
      budget_ms: 100,
      budget_source: 'checked_observation',
    }])),
  })),
  }
  evidence.sha256 = verifiableDocumentDigest(evidence)
  return evidence
}

describe('QA-013–QA-015 browser quality evidence contract', () => {
  it('freezes the desktop, tablet, and phone matrix and all required quality surfaces', () => {
    expect(RESPONSIVE_VIEWPORTS).toEqual([
      { id: 'desktop', width: 1440, height: 1000, mobile: false },
      { id: 'tablet', width: 834, height: 1194, mobile: true },
      { id: 'phone', width: 390, height: 844, mobile: true },
    ])
    expect(ACCESSIBILITY_GATES).toEqual([
      'accessible_names', 'keyboard_focus', 'screen_reader_tree', 'text_contrast',
    ])
    expect(PERFORMANCE_SURFACES).toEqual([
      'startup', 'snapshot_loading', 'transcript_loading', 'graph_view', 'search',
    ])
  })

  it('caps checked regression bounds with explicit beta experience ceilings', () => {
    expect(BETA_EXPERIENCE_BUDGETS_MS).toEqual({
      startup: 1500, snapshot_loading: 3000, transcript_loading: 3500, graph_view: 1000, search: 750,
    })
    expect(deriveRegressionBudgetMs(25)).toBe(175)
    expect(deriveRegressionBudgetMs(80)).toBe(230)
    expect(deriveRegressionBudgetMs(80, { multiplier: 2, additiveMs: 300 })).toBe(380)
    expect(checkedBudget('snapshot_loading', 2_000)).toEqual({
      budget_ms: 3_000,
      experience_budget_ms: 3_000,
      regression_budget_ms: 4_000,
      budget_source: 'checked_observation',
    })
    expect(() => deriveRegressionBudgetMs(0)).toThrow(/positive finite/)
  })

  it('binds every performance budget to the maximum of three retained observations', () => {
    expect(baseline.schema_version).toBe(BROWSER_BASELINE_SCHEMA_VERSION)
    expect(baseline.methodology.runs).toBe(3)
    expect(baseline.capture_artifacts).toHaveLength(3)
    expect(validatePerformanceBaseline(baseline)).toEqual([])
    for (const viewport of baseline.viewports) {
      expect(RESPONSIVE_VIEWPORTS.some((candidate) => candidate.id === viewport.id)).toBe(true)
      for (const surface of PERFORMANCE_SURFACES) {
        const metric = viewport.performance[surface as keyof typeof viewport.performance]
        expect(metric.samples_ms).toHaveLength(3)
        expect(metric.observed_p95_ms).toBe(Math.max(...metric.samples_ms))
        expect(metric).toMatchObject(checkedBudget(surface, metric.observed_p95_ms))
      }
    }
  })

  it('rejects missing, non-finite, self-derived, or digest-tampered checked budgets', () => {
    const missing = structuredClone(baseline) as any
    delete missing.viewports[0].performance.search.budget_ms
    missing.sha256 = verifiableDocumentDigest(missing)
    expect(validatePerformanceBaseline(missing)).toContain('baseline desktop search budget_ms is invalid')

    const nonFinite = structuredClone(baseline) as any
    nonFinite.viewports[0].performance.search.budget_ms = Number.POSITIVE_INFINITY
    nonFinite.sha256 = verifiableDocumentDigest(nonFinite)
    expect(validatePerformanceBaseline(nonFinite)).toContain('baseline desktop search budget_ms is invalid')

    const selfDerived = structuredClone(baseline) as any
    selfDerived.viewports[0].performance.search.budget_source = 'capture_only'
    selfDerived.sha256 = verifiableDocumentDigest(selfDerived)
    expect(validatePerformanceBaseline(selfDerived)).toContain('baseline desktop search budget source is invalid')

    const tampered = structuredClone(baseline) as any
    tampered.methodology.runs = 99
    expect(validatePerformanceBaseline(tampered)).toContain('baseline digest is invalid')

    const evidence = passingEvidence()
    delete evidence.viewports[0].performance.search.budget_ms
    evidence.sha256 = verifiableDocumentDigest(evidence)
    expect(validateBrowserQualityEvidence(evidence)).toContain('desktop has invalid search budget provenance')
  })

  it('recomputes samples, p95, and budgets from captures so a self-digested edit cannot pass', () => {
    const captures = [observation1, observation2, observation3] as any[]
    expect(validateBaselineAgainstCaptures(baseline, captures)).toEqual([])
    const exploit = structuredClone(baseline) as any
    const metric = exploit.viewports[0].performance.search
    metric.samples_ms = metric.samples_ms.map((sample: number) => sample + 10)
    metric.observed_p95_ms = Math.max(...metric.samples_ms)
    Object.assign(metric, checkedBudget('search', metric.observed_p95_ms))
    exploit.sha256 = verifiableDocumentDigest(exploit)
    expect(validatePerformanceBaseline(exploit)).toEqual([])
    expect(validateBaselineAgainstCaptures(exploit, captures)).toEqual(expect.arrayContaining([
      'baseline desktop search samples do not match captures',
      'baseline desktop search p95 does not match captures',
    ]))
  })

  it('never permits DOM fallback timing to enter retained performance samples', () => {
    const interactionModes = {
      pointer: { elapsed_ms: 137, performance_eligible: true },
      keyboard: { elapsed_ms: 211, performance_eligible: false },
      dom_fallback: { elapsed_ms: 1, performance_eligible: false, diagnostic_only: true },
    }
    expect(performanceSampleForJourney(interactionModes)).toBe(137)
    interactionModes.dom_fallback.elapsed_ms = 99_999
    expect(performanceSampleForJourney(interactionModes)).toBe(137)
    interactionModes.dom_fallback.performance_eligible = true
    expect(() => performanceSampleForJourney(interactionModes)).toThrow(/diagnostic-only/)
  })

  it('rejects dirty or stale source identity before trusting build artifacts', () => {
    const manifest = {
      source_status: 'clean', source_commit: 'a'.repeat(40), source_tree_sha256: 'b'.repeat(64),
      source_checked_at: '2026-08-02T10:00:00.000Z', artifacts_built_at: '2026-08-02T10:00:01.000Z',
    }
    expect(validateBuildSourceIdentity(manifest, {
      source_status: 'clean', source_commit: manifest.source_commit, source_tree_sha256: manifest.source_tree_sha256,
    })).toEqual([])
    expect(validateBuildSourceIdentity(manifest, {
      source_status: 'dirty', source_commit: manifest.source_commit, source_tree_sha256: manifest.source_tree_sha256,
    })).toContain('tracked source tree is dirty')
  })

  it('confines retained observations to real non-symlink files in the approved directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'browser-evidence-path-'))
    try {
      const approved = join(root, 'docs', 'qa-evidence', 'browser-quality')
      mkdirSync(approved, { recursive: true })
      writeFileSync(join(approved, 'capture.json'), '{}')
      writeFileSync(join(root, 'docs', 'qa-evidence', 'not-approved.json'), '{}')
      symlinkSync(join(approved, 'capture.json'), join(approved, 'linked.json'))
      expect(resolveApprovedEvidencePath(root, 'docs/qa-evidence/browser-quality/capture.json'))
        .toBe(realpathSync(join(approved, 'capture.json')))
      expect(() => resolveApprovedEvidencePath(root, 'docs/qa-evidence/browser-quality/linked.json')).toThrow(/symlink/)
      expect(() => resolveApprovedEvidencePath(root, 'docs/qa-evidence/not-approved.json')).toThrow(/outside/)
      expect(() => resolveApprovedEvidencePath(root, join(approved, 'capture.json'))).toThrow(/relative/)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('redacts nested credentials, bearer values, assignments, and URL credentials before artifacts', () => {
    const redacted = redactEvidence({
      authorization: 'Bearer top-secret',
      nested: {
        message: 'ORCHESTRA_TOKEN=abc123 GET /?token=url-secret&safe=1',
        safe: 'job-123',
      },
    })
    expect(redacted).toEqual({
      authorization: '[REDACTED]',
      nested: {
        message: 'ORCHESTRA_TOKEN=[REDACTED] GET /?token=[REDACTED]&safe=1',
        safe: 'job-123',
      },
    })
    expect(evidenceDigest(redacted)).toMatch(/^[a-f0-9]{64}$/)
  })

  it('calculates WCAG contrast ratios for opaque computed colors', () => {
    expect(contrastRatio('rgb(0, 0, 0)', 'rgb(255, 255, 255)')).toBeCloseTo(21, 5)
    expect(contrastRatio('rgb(119, 119, 119)', 'rgb(255, 255, 255)')).toBeCloseTo(4.478, 2)
    expect(contrastRatio('rgba(0, 0, 0, 0.5)', 'rgb(255, 255, 255)')).toBeNull()
  })

  it('fails closed when a viewport, accessibility gate, performance surface, or redaction is absent', () => {
    const complete = passingEvidence()
    expect(validateBrowserQualityEvidence(complete)).toEqual([])

    const incomplete = structuredClone(complete)
    incomplete.viewports = incomplete.viewports.filter((viewport) => viewport.id !== 'tablet')
    incomplete.viewports[0].horizontal_overflow_px = 4
    incomplete.viewports[0].accessibility.keyboard_focus.passed = false
    delete incomplete.viewports[0].performance.search
    delete incomplete.viewports[1].performance.graph_view.quality_gate_passed
    ;(incomplete as any).token = 'unsafe'
    incomplete.sha256 = verifiableDocumentDigest(incomplete)

    expect(validateBrowserQualityEvidence(incomplete)).toEqual(expect.arrayContaining([
      'missing tablet viewport',
      'desktop has horizontal overflow',
      'desktop failed keyboard_focus',
      'desktop is missing search performance evidence',
      'tablet graph_view is missing quality-linked performance status',
      'evidence contains secret-shaped fields or values',
    ]))
  })
})
