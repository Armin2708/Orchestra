import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildApprovalBody } from '../web/src/CardDrawer.js'
import { summarizeTrackbookDelivery } from '../web/src/CardTrackbookSummary.js'
import { normalizeDeliveriesResponse, normalizeDeliveryReport } from '../web/src/osApi.js'
import { deliveryEvidenceText } from '../web/src/TrackbookPane.js'

const cockpitSource = readFileSync(new URL('../web/src/WorkspaceCockpit.tsx', import.meta.url), 'utf8')
const trackbookSource = readFileSync(new URL('../web/src/TrackbookPane.tsx', import.meta.url), 'utf8')
const drawerSource = readFileSync(new URL('../web/src/CardTrackbookSummary.tsx', import.meta.url), 'utf8')
const cardDrawerSource = readFileSync(new URL('../web/src/CardDrawer.tsx', import.meta.url), 'utf8')
const trackbookCss = readFileSync(new URL('../web/src/agentOs.css', import.meta.url), 'utf8')

describe('delivery Trackbook response normalization', () => {
  it('normalizes frozen snake-case fields and JSON-encoded nested values', () => {
    const collection = normalizeDeliveriesResponse({
      deliveries: JSON.stringify([{
        id: 'delivery-2', card_id: '42', workspace_id: 'ws-8', status: 'in review', sequence: '2',
        asked: JSON.stringify({
          objective: 'Ship a readable delivery ledger',
          deliverables: [{ id: 'd1', text: 'Track promises' }],
          acceptance_criteria: ['Never call a partial result complete'],
          non_goals: ['Replace the terminal'], risks: ['Missing evidence'],
          verify_commands: ['npm test'], contract_version: 3,
        }),
        summary: 'Added the Trackbook.', human_summary: 'Readable and auditable.',
        delivered_items: JSON.stringify([{ id: 'd1', text: 'Track promises', status: 'claimed' }]),
        deliverable_results: JSON.stringify([{
          deliverable_id: 'd1', text: 'Track promises', status: 'verified',
          evidence_items: [{ kind: 'test', summary: 'Vitest passed' }],
        }]),
        criterion_results: JSON.stringify([{
          criterion_id: 'c1', text: 'Never call a partial result complete', status: 'passed', evidence: ['review-12'],
        }]),
        changed_files: JSON.stringify([{ path: 'web/src/TrackbookPane.tsx' }]),
        commits: JSON.stringify([{ sha: 'abc123' }]), artifact_ids: JSON.stringify([{ artifact_id: 'artifact-4' }]),
        claims: JSON.stringify([{ claim: 'Looks good', source: 'worker' }]),
        submitted_at: '2026-07-22T10:00:00Z',
      }]),
      current: 'null',
    })

    expect(collection.current?.id).toBe('delivery-2')
    expect(collection.current?.card_id).toBe(42)
    expect(collection.current?.status).toBe('in_review')
    expect(collection.current?.asked.objective).toBe('Ship a readable delivery ledger')
    expect(collection.current?.asked.version).toBe(3)
    expect(collection.current?.deliverable_results[0]).toMatchObject({ id: 'd1', status: 'verified' })
    expect(collection.current?.deliverable_results[0].evidence).toEqual([{ kind: 'test', summary: 'Vitest passed' }])
    expect(collection.current?.changed_files).toEqual(['web/src/TrackbookPane.tsx'])
    expect(collection.current?.commits).toEqual(['abc123'])
    expect(collection.current?.artifact_ids).toEqual(['artifact-4'])
    expect(collection.current?.claims[0]).toMatchObject({ text: 'Looks good', source: 'worker' })
  })

  it('accepts camel-case and legacy asked aliases while preferring deliverable results', () => {
    const report = normalizeDeliveryReport({
      id: 7,
      askedSnapshot: { objective: 'Legacy request', deliverables: [{ id: 'one', description: 'One outcome' }] },
      deliveredItems: [{ id: 'one', text: 'Agent says complete', status: 'complete', evidence: ['claim-like input'] }],
      deliverableResults: [{ id: 'one', text: 'One outcome', status: 'partial', evidence: ['test output'], gaps: ['Review missing'] }],
      criterionResults: [], changedFiles: ['a.ts'], artifactIds: [9], parentDeliveryId: 6,
    })

    expect(report.asked.objective).toBe('Legacy request')
    expect(report.delivered_items[0].text).toBe('Agent says complete')
    expect(report.deliverable_results[0]).toMatchObject({ text: 'One outcome', status: 'partial', gaps: ['Review missing'] })
    expect(report.parent_delivery_id).toBe(6)
  })

  it('normalizes the exact domain outcome, evidence, override, parent, and verification fields', () => {
    const report = normalizeDeliveryReport({
      id: 'report-12', card_id: 42, sequence: 4, status: 'verified',
      asked: {
        objective: 'Prove the interface',
        deliverables: [{ id: 'ui', text: 'Responsive Trackbook', required: false, metadata: { owner: 'web' } }],
        acceptance_criteria: [{ id: 'a11y', text: 'Keyboard reachable', required: true, deliverable_ids: ['ui'] }],
        dependencies: [7], base_ref: 'main', budget_tokens: 12_000, budget_cents: 250,
        priority: 8, policy_id: 'policy-1', contract_version: 3,
        contract_updated_at: '2026-07-22T12:00:00Z',
      },
      deliverable_results: [{
        id: 'ui', text: 'Responsive Trackbook', outcome: 'missed', required: false,
        note: 'The narrow inspector still wraps.', actor: 'verifier-1',
        evidence_refs: [{ ref: 'artifact:ui-7', label: 'Playwright review' }],
        override: { actor: 'human-reviewer', reason: 'Accepted after manual inspection', at: '2026-07-22T13:10:00Z' },
      }],
      criterion_results: [], claims: [{ text: 'The layout is responsive' }],
      parent_report_id: 'report-11', lineage_id: 'lineage-1', created_by: 'worker-1', submitted_by: 'worker-1',
      verified_by: 'verifier-1', accepted_by: 'reviewer-1', rejected_by: 'reviewer-2',
      acceptance_note: 'Manual review complete.', rejection_reason: 'Viewport evidence was missing.',
      verified_at: '2026-07-22T13:00:00Z',
    })

    expect(report.deliverable_results[0]).toMatchObject({
      status: 'missed',
      required: false,
      note: 'The narrow inspector still wraps.',
      actor: 'verifier-1',
      evidence: [{ ref: 'artifact:ui-7', label: 'Playwright review' }],
      override: { actor: 'human-reviewer', reason: 'Accepted after manual inspection', created_at: '2026-07-22T13:10:00Z' },
    })
    expect(report.asked).toMatchObject({
      dependencies: [7], base_ref: 'main', budget_tokens: 12_000, budget_cents: 250,
      priority: 8, policy_id: 'policy-1', version: 3, updated_at: '2026-07-22T12:00:00Z',
    })
    expect(report.asked.deliverables[0]).toMatchObject({ required: false, metadata: { owner: 'web' } })
    expect(report.asked.acceptance_criteria[0]).toMatchObject({ required: true, deliverable_ids: ['ui'] })
    expect(report).toMatchObject({
      lineage_id: 'lineage-1', created_by: 'worker-1', verified_by: 'verifier-1',
      accepted_by: 'reviewer-1', rejected_by: 'reviewer-2', acceptance_note: 'Manual review complete.',
      rejection_reason: 'Viewport evidence was missing.',
    })
    expect(report.parent_delivery_id).toBe('report-11')
    expect(report.verified_at).toBe('2026-07-22T13:00:00Z')
    expect(deliveryEvidenceText(report.deliverable_results[0].evidence[0])).toBe('Playwright review — artifact:ui-7')
    expect(report.claims[0].text).toBe('The layout is responsive')
  })

  it('accepts a direct response array and degrades malformed JSON safely', () => {
    const collection = normalizeDeliveriesResponse(JSON.stringify([
      { id: 'newer', sequence: 2, asked: '{bad json', delivered_items: 'Agent claims done' },
      { id: 'older', sequence: 1, asked: { objective: 'Older' } },
    ]))

    expect(collection.deliveries.map((delivery) => delivery.id)).toEqual(['newer', 'older'])
    expect(collection.current?.id).toBe('newer')
    expect(collection.current?.asked.objective).toBe('')
    expect(collection.current?.delivered_items[0]).toMatchObject({ status: 'claimed', evidence: [], claim: 'Agent claims done' })
    expect(collection.current?.deliverable_results[0]).toMatchObject({ status: 'unverified', evidence: [] })
  })

  it('uses the explicit current report as the authoritative revision without duplicating it', () => {
    const collection = normalizeDeliveriesResponse({
      deliveries: [{ id: 'same', sequence: 2, summary: 'stale list copy' }, null, 'null'],
      current: { id: 'same', sequence: 2, summary: 'authoritative current copy' },
    })

    expect(collection.deliveries).toHaveLength(1)
    expect(collection.deliveries[0].summary).toBe('authoritative current copy')
    expect(collection.current).toBe(collection.deliveries[0])
  })
})

describe('human-readable Trackbook summary', () => {
  it('does not count claims, partial results, or unverifiable results as delivered evidence', () => {
    const report = normalizeDeliveryReport({
      id: 'delivery-1',
      asked: { objective: 'Prove four outcomes', deliverables: ['Claim only', 'Partial', 'Unverifiable', 'Observed'] },
      delivered_items: ['All done'],
      deliverable_results: [
        { text: 'Claim only', status: 'complete', claim: 'done' },
        { text: 'Partial', status: 'partial', evidence: ['some output'] },
        { text: 'Unverifiable', status: 'unverifiable', evidence: ['agent note'] },
        { text: 'Observed', status: 'passed', evidence: [{ kind: 'test', result: 'pass' }] },
      ],
    })

    const summary = summarizeTrackbookDelivery(report, { title: 'Fallback', description: '' })
    expect(summary.headline).toBe('Delivered 1 of 4 required outcomes; 3 need evidence.')
    expect(summary).toMatchObject({ complete: 1, total: 4, needsEvidence: 3, failed: 0, tone: 'attention' })
  })

  it('counts a recorded human override but still writes failed outcomes separately', () => {
    const report = normalizeDeliveryReport({
      id: 'delivery-3',
      asked: { objective: 'Two outcomes', deliverables: ['Approved exception', 'Broken output'] },
      deliverable_results: [
        { text: 'Approved exception', outcome: 'missed', evidence_refs: [], override: { actor: 'reviewer', reason: 'Manual inspection', at: '2026-07-22T13:00:00Z' } },
        { text: 'Broken output', outcome: 'missed', evidence_refs: ['test failed'] },
      ],
    })

    const summary = summarizeTrackbookDelivery(report, { title: 'Fallback', description: '' })
    expect(summary.headline).toBe('Delivered 1 of 2 required outcomes; 1 failed.')
    expect(summary).toMatchObject({ complete: 1, needsEvidence: 0, failed: 1, tone: 'failed' })
    expect(report.deliverable_results[0].status).toBe('missed')
  })

  it('combines required deliverables and criteria while excluding optional misses from health', () => {
    const report = normalizeDeliveryReport({
      id: 'delivery-required', status: 'accepted',
      asked: {
        objective: 'Ship the required work',
        deliverables: [
          { id: 'core', text: 'Core output', required: true },
          { id: 'bonus', text: 'Optional polish', required: false },
        ],
        acceptance_criteria: [{ id: 'tests', text: 'Tests pass', required: true }],
      },
      deliverable_results: [
        { deliverable_id: 'core', text: 'Core output', required: true, outcome: 'met', evidence_refs: ['test:core'] },
        { deliverable_id: 'bonus', text: 'Optional polish', required: false, outcome: 'missed', evidence_refs: [] },
      ],
      criterion_results: [
        { criterion_id: 'tests', text: 'Tests pass', required: true, outcome: 'missed', evidence_refs: ['test:failed'] },
      ],
    })

    const summary = summarizeTrackbookDelivery(report, { title: 'Fallback', description: '' })
    expect(summary).toMatchObject({ complete: 1, total: 2, needsEvidence: 0, failed: 1, tone: 'failed' })
    expect(summary.headline).toBe('Delivered 1 of 2 required outcomes; 1 failed.')

    report.criterion_results[0] = { ...report.criterion_results[0], status: 'met', evidence: ['test:passed'] }
    const accepted = summarizeTrackbookDelivery(report, { title: 'Fallback', description: '' })
    expect(accepted).toMatchObject({ complete: 2, total: 2, failed: 0, tone: 'complete' })
  })
})

describe('Trackbook interaction states', () => {
  it('exposes loading, hard-error, stale, and empty states without hiding claims as evidence', () => {
    for (const phrase of [
      'Trackbook could not load', 'Showing the last loaded Trackbook', 'No delivery has been submitted yet.',
      'No observed evidence has been recorded yet.', 'Agent claim · not evidence',
    ]) expect(trackbookSource).toContain(phrase)
    expect(trackbookSource).toContain('aria-busy={deliveries.status === \'loading\'}')
    expect(trackbookSource).toContain('role="alert"')
    expect(trackbookSource).toContain('aria-live="polite"')
    expect(trackbookSource).toContain('<StatusBadge status={status} />')
    expect(trackbookSource).toContain('<b>Human override</b>')
  })

  it('keeps the compact drawer summary additive, screen-reader legible, and honest when unlinked', () => {
    expect(drawerSource).toContain('aria-busy={state.status === \'loading\'}')
    expect(drawerSource).toContain('role="status"')
    expect(drawerSource).toContain('claims are not counted as evidence')
    expect(drawerSource).toContain('Full evidence becomes available when this card is linked to a workspace.')
    expect(drawerSource).toContain("localStorage.setItem('orchestra-os-pane', 'trackbook')")
  })

  it('treats an explicit Board approval as confirmation and surfaces approval failures', () => {
    expect(buildApprovalBody(' ship it ')).toEqual({ note: 'ship it', confirm: true })
    expect(buildApprovalBody('')).toEqual({ confirm: true })
    expect(cardDrawerSource).toContain('role="alert"')
    expect(cardDrawerSource).toContain('Could not approve this delivery.')
    expect(cardDrawerSource).toContain('disabled={approving || verification?.running}')
  })

  it('does not present card-global evidence as belonging to a historical revision', () => {
    expect(trackbookSource).toContain('Later-revision evidence is intentionally hidden')
    expect(trackbookSource).toContain('viewingHistorical')
  })

  it('renders frozen contract metadata, verifier notes, and lifecycle actors', () => {
    expect(trackbookSource).toContain('const comparisonRows = [...deliverableRows, ...criterionRows]')
    expect(trackbookSource).toContain('<AskedMetadata asked={asked} />')
    expect(trackbookSource).toContain('<b>Verifier note</b>')
    expect(trackbookSource).toContain('Recorded by')
    expect(trackbookSource).toContain('rejection_reason')
    expect(trackbookSource).toContain('acceptance_note')
  })

  it('uses tab semantics and forces the Trackbook to one column below 768px', () => {
    expect(cockpitSource).toContain("{ id: 'trackbook', label: 'Trackbook', icon: 'evidence' }")
    expect(cockpitSource).toContain('role="tab" aria-selected=')
    expect(cockpitSource).toContain('role="tabpanel"')
    expect(trackbookCss).toMatch(/@media \(max-width: 767px\)[\s\S]*?\.os-trackbook-comparison[\s\S]*?grid-template-columns:\s*1fr/)
    expect(trackbookCss).toContain('.drawer-trackbook-open:focus-visible')
    expect(trackbookCss).toMatch(/@container trackbook \(max-width:\s*520px\)[\s\S]*?\.os-trackbook-hero[\s\S]*?grid-template-columns:\s*1fr/)
  })
})
