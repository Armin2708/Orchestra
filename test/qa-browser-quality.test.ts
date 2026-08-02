import { describe, expect, it } from 'vitest'
import baseline from '../docs/qa-browser-performance-baseline.json'
import {
  ACCESSIBILITY_GATES,
  BROWSER_QUALITY_SCHEMA_VERSION,
  PERFORMANCE_SURFACES,
  RESPONSIVE_VIEWPORTS,
  contrastRatio,
  deriveBudgetMs,
  evidenceDigest,
  redactEvidence,
  validateBrowserQualityEvidence,
} from '../scripts/lib/browser-quality.mjs'

const passingEvidence = () => ({
  schema_version: BROWSER_QUALITY_SCHEMA_VERSION,
  viewports: RESPONSIVE_VIEWPORTS.map((viewport) => ({
    ...viewport,
    horizontal_overflow_px: 0,
    console_errors: [],
    page_errors: [],
    failed_requests: [],
    accessibility: Object.fromEntries(ACCESSIBILITY_GATES.map((gate) => [gate, { passed: true }])),
    performance: Object.fromEntries(PERFORMANCE_SURFACES.map((surface) => [surface, {
      observed_ms: 10,
      budget_ms: 100,
    }])),
  })),
})

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

  it('derives budgets from observed p95 values instead of embedding unexplained limits', () => {
    expect(deriveBudgetMs(25)).toBe(125)
    expect(deriveBudgetMs(80)).toBe(320)
    expect(deriveBudgetMs(80, { multiplier: 2, additiveMs: 300 })).toBe(380)
    expect(() => deriveBudgetMs(0)).toThrow(/positive finite/)
  })

  it('binds every performance budget to the maximum of three retained observations', () => {
    expect(baseline.methodology.runs).toBe(3)
    expect(baseline.capture_digests).toHaveLength(3)
    for (const viewport of baseline.viewports) {
      expect(RESPONSIVE_VIEWPORTS.some((candidate) => candidate.id === viewport.id)).toBe(true)
      for (const surface of PERFORMANCE_SURFACES) {
        const metric = viewport.performance[surface as keyof typeof viewport.performance]
        expect(metric.samples_ms).toHaveLength(3)
        expect(metric.observed_ms).toBe(Math.max(...metric.samples_ms))
        expect(metric.budget_ms).toBe(deriveBudgetMs(metric.observed_ms))
      }
    }
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

    expect(validateBrowserQualityEvidence(incomplete)).toEqual(expect.arrayContaining([
      'missing tablet viewport',
      'desktop has horizontal overflow',
      'desktop failed keyboard_focus',
      'desktop is missing search performance evidence',
      'evidence contains secret-shaped fields or values',
    ]))
  })
})
