import { describe, expect, it } from 'vitest'
import baseline from '../docs/qa-browser-performance-baseline.json'
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
  redactEvidence,
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
      name: `journey-${index}`,
      accessibility: Object.fromEntries(ACCESSIBILITY_GATES.map((gate) => [gate, { passed: true }])),
    })),
    performance: Object.fromEntries(PERFORMANCE_SURFACES.map((surface) => [surface, {
      observed_ms: 10,
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
    ;(incomplete as any).token = 'unsafe'
    incomplete.sha256 = verifiableDocumentDigest(incomplete)

    expect(validateBrowserQualityEvidence(incomplete)).toEqual(expect.arrayContaining([
      'missing tablet viewport',
      'desktop has horizontal overflow',
      'desktop failed keyboard_focus',
      'desktop is missing search performance evidence',
      'evidence contains secret-shaped fields or values',
    ]))
  })
})
