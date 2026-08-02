import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../web/src/JobDeliveryDetail.tsx', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../web/src/jobDeliveryDetail.css', import.meta.url), 'utf8')

describe('Job Detail requested versus delivered surface', () => {
  it('keeps frozen requests, observed outcomes, claims, gaps and overrides distinct', () => {
    for (const phrase of [
      'Requested versus delivered',
      'The frozen contract',
      'The observed result',
      'Agent claims · not evidence',
      'Evidence gaps',
      'Human override',
    ]) expect(source).toContain(phrase)
    expect(source).toContain('detail.requested.deliverables')
    expect(source).toContain('report.deliverable_results')
    expect(source).toContain('report.criterion_results')
  })

  it('shows exact command, environment/output digests, artifact lineage, comments and shipments', () => {
    for (const phrase of [
      'Verification and provenance',
      'Verification runs',
      'Artifact attestations',
      'Comments at exact evidence',
      'Canonical shipped records',
      'Reopened after regression',
    ]) expect(source).toContain(phrase)
    expect(source).toContain('run.command')
    expect(source).toContain('run.environment_sha256')
    expect(source).toContain('run.output_sha256')
    expect(source).toContain('artifact.attestation_sha256')
    expect(source).toContain('locationText(comment.location)')
    expect(source).toContain('shipment.manifest_sha256')
  })

  it('exposes every requested delivery filter and collapses to one column on narrow screens', () => {
    for (const filter of ['Awaiting review', 'Evidence gaps', 'Rejected', 'Overridden', 'Shipped']) {
      expect(source).toContain(filter)
    }
    expect(source).toContain('aria-pressed={value === filter.id}')
    expect(styles).toMatch(/@media \(max-width: 820px\)[\s\S]*?\.job-delivery-comparison[\s\S]*?grid-template-columns:\s*1fr/)
    expect(styles).toMatch(/@media \(max-width: 520px\)[\s\S]*?\.job-delivery-heading dl[\s\S]*?grid-template-columns:\s*1fr/)
  })
})
