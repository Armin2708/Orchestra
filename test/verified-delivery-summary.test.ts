import { describe, expect, it } from 'vitest'
import {
  createVerifiedDeliverySummary,
  generateVerifiedDeliverySummary,
  generateVerifiedDeliverySummaryFromHistory,
  selectLatestAcceptedDeliveryRevision,
  type DeliveryAskedSnapshot,
  type DeliveryReport,
} from '../src/agent-os/index.js'

const ASKED: DeliveryAskedSnapshot = {
  objective: 'Generate a verified delivery summary.',
  deliverables: [
    { id: 'del-b', text: 'Machine summary', required: true, metadata: { owner: 'agent' } },
    { id: 'del-a', text: 'Human summary', required: true, metadata: { secret: 'metadata-secret' } },
  ],
  acceptance_criteria: [
    {
      id: 'criterion-b',
      text: 'Evidence is preserved',
      required: true,
      deliverable_ids: ['del-b'],
      metadata: { verifier: 'reviewer' },
    },
    {
      id: 'criterion-a',
      text: 'Claims stay distinct',
      required: true,
      deliverable_ids: ['del-a'],
      metadata: {},
    },
  ],
  verify_commands: ['npm test'],
  non_goals: ['Do not ingest knowledge.'],
  risks: ['Summaries can overstate claims.'],
  dependencies: [9, 2, 9],
  base_ref: 'main',
  budget_tokens: 5_000,
  budget_cents: 200,
  priority: 3,
  policy_id: 'policy-1',
  contract_version: 7,
  contract_updated_at: '2026-07-25T09:00:00.000Z',
}

function acceptedReport(overrides: Partial<DeliveryReport> = {}): DeliveryReport {
  return {
    id: 'report-accepted',
    lineage_id: 'lineage-1',
    parent_report_id: 'report-rejected',
    sequence: 2,
    board_id: 11,
    card_id: 22,
    job_id: 'job-1',
    session_id: 'session-1',
    workspace_id: 'workspace-1',
    status: 'accepted',
    asked: structuredClone(ASKED),
    summary: 'Implemented the requested summaries.',
    delivered_items: [
      { id: 'item-a', deliverable_id: 'del-a', text: 'Human summary', status: 'delivered' },
      { id: 'item-b', deliverable_id: 'del-b', text: 'Machine summary', status: 'delivered' },
    ],
    claims: [
      { id: 'claim-z', text: 'Everything passes.', criterion_id: 'criterion-b', deliverable_id: null },
      { id: 'claim-a', text: 'Claims are labeled.', criterion_id: 'criterion-a', deliverable_id: 'del-a' },
    ],
    changed_files: ['src/z.ts', 'src/a.ts'],
    commits: ['ffff0000', 'aaaa0000'],
    artifact_ids: ['artifact-1'],
    gaps: [],
    deliverable_results: [
      result('deliverable', 'del-a', 'Human summary'),
      result('deliverable', 'del-b', 'Machine summary'),
    ],
    criterion_results: [
      result('criterion', 'criterion-a', 'Claims stay distinct'),
      result('criterion', 'criterion-b', 'Evidence is preserved'),
    ],
    created_by: 'agent',
    submitted_by: 'agent',
    verified_by: 'verifier',
    accepted_by: 'reviewer',
    rejected_by: null,
    acceptance_note: 'Evidence checked.',
    rejection_reason: null,
    created_at: '2026-07-25T10:00:00.000Z',
    updated_at: '2026-07-25T10:03:00.000Z',
    submitted_at: '2026-07-25T10:01:00.000Z',
    verified_at: '2026-07-25T10:02:00.000Z',
    accepted_at: '2026-07-25T10:03:00.000Z',
    rejected_at: null,
    ...overrides,
  }
}

function result(
  kind: 'deliverable' | 'criterion',
  id: string,
  text: string,
): DeliveryReport['deliverable_results'][number] & DeliveryReport['criterion_results'][number] {
  return {
    report_id: 'report-accepted',
    deliverable_id: kind === 'deliverable' ? id : 'unused-deliverable',
    criterion_id: kind === 'criterion' ? id : 'unused-criterion',
    text,
    required: true,
    outcome: 'met',
    effective_outcome: 'met',
    note: null,
    evidence_refs: [
      { kind: 'commit', ref: 'bbbb0000', label: 'Commit evidence' },
      { kind: 'artifact', ref: 'artifact-1', label: 'Test report' },
    ],
    override: null,
    actor: 'verifier',
    created_at: '2026-07-25T10:02:00.000Z',
    updated_at: '2026-07-25T10:02:00.000Z',
  }
}

describe('verified delivery summary', () => {
  it('generates public human and machine summaries from the accepted frozen request', () => {
    const accepted = acceptedReport()
    const generated = generateVerifiedDeliverySummary({
      latestAcceptedReport: accepted,
      currentReport: accepted,
    })

    expect(generated.machine).toMatchObject({
      schema_version: 1,
      format: 'verified-delivery-summary',
      request: {
        objective: ASKED.objective,
        contract_version: 7,
        dependencies: [2, 9],
        acceptance_criteria: [
          { criterion_id: 'criterion-b' },
          { criterion_id: 'criterion-a' },
        ],
      },
      verification: {
        report_status: 'accepted',
        verified_by: 'verifier',
        accepted_by: 'reviewer',
      },
      provenance: {
        report_id: accepted.id,
        revision: 2,
        selected_revision_is_current: true,
      },
    })
    expect(generated.machine.claims.assertions.map((claim) => claim.claim_id))
      .toEqual(['claim-a', 'claim-z'])
    expect(generated.machine.claims.claimed_artifact_ids).toEqual(['artifact-1'])
    expect(generated.machine.verification.criteria[0].evidence.map((item) => item.evidence_id))
      .toEqual(['artifact-1', 'bbbb0000'])
    expect(generated.human).toContain('Agent claims (not evidence)')
    expect(generated.human).toContain('Observed verification')
    expect(generated.human).toContain('artifact:artifact-1')
    expect(JSON.parse(generated.json)).toEqual(generated.machine)
    expect(generated.json.endsWith('\n')).toBe(true)
  })

  it('selects the latest accepted revision independently of input order', () => {
    const oldAccepted = acceptedReport({
      id: 'accepted-old',
      lineage_id: 'lineage-old',
      sequence: 1,
      accepted_at: '2026-07-25T08:00:00.000Z',
    })
    const rejectedRevision = acceptedReport({
      id: 'rejected-revision',
      lineage_id: oldAccepted.lineage_id,
      parent_report_id: oldAccepted.id,
      sequence: 3,
      status: 'rejected',
      accepted_at: null,
      accepted_by: null,
    })
    const latestAccepted = acceptedReport({
      id: 'accepted-latest',
      lineage_id: 'lineage-new',
      sequence: 1,
      accepted_at: '2026-07-25T12:00:00.000Z',
    })

    expect(selectLatestAcceptedDeliveryRevision([
      latestAccepted, rejectedRevision, oldAccepted,
    ])?.id).toBe(latestAccepted.id)
    expect(selectLatestAcceptedDeliveryRevision([
      oldAccepted, rejectedRevision, latestAccepted,
    ])?.id).toBe(latestAccepted.id)

    const lexicallyLaterButEarlierInstant = acceptedReport({
      id: 'offset-earlier',
      accepted_at: '2026-07-25T10:30:00+02:00',
    })
    const chronologicallyLater = acceptedReport({
      id: 'utc-later',
      accepted_at: '2026-07-25T09:00:00Z',
    })
    expect(selectLatestAcceptedDeliveryRevision([
      lexicallyLaterButEarlierInstant,
      chronologicallyLater,
    ])?.id).toBe(chronologicallyLater.id)
  })

  it('summarizes the latest accepted revision while reporting a newer unaccepted current report exactly', () => {
    const accepted = acceptedReport()
    const current = acceptedReport({
      id: 'current-draft',
      lineage_id: 'lineage-current',
      parent_report_id: null,
      sequence: 1,
      status: 'draft',
      asked: { ...structuredClone(ASKED), objective: 'A newer request that is not accepted.' },
      summary: 'Unaccepted current claims must not appear.',
      accepted_at: null,
      accepted_by: null,
      verified_at: null,
      verified_by: null,
    })
    const generated = generateVerifiedDeliverySummaryFromHistory({
      reports: [current, accepted],
      currentReport: current,
    })

    expect(generated?.machine.request.objective).toBe(ASKED.objective)
    expect(generated?.machine.claims.agent_summary).toBe(accepted.summary)
    expect(generated?.machine.provenance).toMatchObject({
      report_id: accepted.id,
      selected_revision_is_current: false,
      current_report: { report_id: current.id, status: 'draft' },
    })
    expect(generated?.json).not.toContain(current.summary)
    expect(generated?.json).not.toContain(current.asked.objective)
  })

  it('returns no verified summary without an accepted revision and rejects an unaccepted direct input', () => {
    const submitted = acceptedReport({
      status: 'submitted',
      accepted_at: null,
      accepted_by: null,
    })
    expect(generateVerifiedDeliverySummaryFromHistory({
      reports: [submitted],
      currentReport: submitted,
    })).toBeNull()
    expect(() => createVerifiedDeliverySummary({
      latestAcceptedReport: submitted,
      currentReport: submitted,
    })).toThrow(/accepted status/)
  })

  it('keeps missing, unverifiable, evidence-free, and overridden criteria distinct', () => {
    const report = acceptedReport({
      asked: {
        ...structuredClone(ASKED),
        acceptance_criteria: [
          { id: 'criterion-missing', text: 'Missing row', required: true, deliverable_ids: [], metadata: {} },
          { id: 'criterion-unverifiable', text: 'Cannot verify', required: false, deliverable_ids: [], metadata: {} },
          { id: 'criterion-no-evidence', text: 'Evidence absent', required: false, deliverable_ids: [], metadata: {} },
          { id: 'criterion-override', text: 'Human exception', required: true, deliverable_ids: [], metadata: {} },
        ],
      },
      criterion_results: [
        {
          ...result('criterion', 'criterion-unverifiable', 'Cannot verify'),
          outcome: 'unverifiable',
          effective_outcome: 'unverifiable',
          evidence_refs: [],
        },
        {
          ...result('criterion', 'criterion-no-evidence', 'Evidence absent'),
          evidence_refs: [],
        },
        {
          ...result('criterion', 'criterion-override', 'Human exception'),
          outcome: 'missed',
          effective_outcome: 'overridden',
          evidence_refs: [],
          override: {
            actor: 'human-reviewer',
            reason: 'Known platform limitation',
            at: '2026-07-25T10:02:30.000Z',
          },
        },
      ],
    })
    const summary = createVerifiedDeliverySummary({
      latestAcceptedReport: report,
      currentReport: report,
    })

    expect(summary.verification.criteria.map((item) => ({
      id: item.subject_id,
      outcome: item.outcome,
      effective: item.effective_outcome,
    }))).toEqual([
      { id: 'criterion-missing', outcome: 'missing', effective: 'missing' },
      { id: 'criterion-unverifiable', outcome: 'unverifiable', effective: 'unverifiable' },
      { id: 'criterion-no-evidence', outcome: 'met', effective: 'met' },
      { id: 'criterion-override', outcome: 'missed', effective: 'overridden' },
    ])
    expect(summary.verification.criteria[3].override).toEqual({
      actor: 'human-reviewer',
      reason: 'Known platform limitation',
      at: '2026-07-25T10:02:30.000Z',
    })
    expect(summary.gaps).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'verification_missing', subject_id: 'criterion-missing' }),
      expect.objectContaining({ code: 'outcome_unverifiable', subject_id: 'criterion-unverifiable' }),
      expect.objectContaining({ code: 'evidence_missing', subject_id: 'criterion-no-evidence' }),
    ]))
    expect(summary.gaps).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ subject_id: 'criterion-override', code: 'outcome_missed' }),
    ]))
  })

  it('uses frozen-request order and canonicalizes result, claim, file, commit, and evidence ordering', () => {
    const original = acceptedReport()
    const shuffled = acceptedReport({
      delivered_items: [...original.delivered_items].reverse(),
      claims: [...original.claims].reverse(),
      changed_files: [...original.changed_files].reverse(),
      commits: [...original.commits].reverse(),
      deliverable_results: [...original.deliverable_results].reverse().map((item) => ({
        ...item,
        evidence_refs: [...item.evidence_refs].reverse(),
      })),
      criterion_results: [...original.criterion_results].reverse().map((item) => ({
        ...item,
        evidence_refs: [...item.evidence_refs].reverse(),
      })),
    })

    const first = generateVerifiedDeliverySummary({
      latestAcceptedReport: original,
      currentReport: original,
    })
    const second = generateVerifiedDeliverySummary({
      latestAcceptedReport: shuffled,
      currentReport: shuffled,
    })

    expect(second).toEqual(first)
    expect(first.machine.request.deliverables.map((item) => item.deliverable_id))
      .toEqual(['del-b', 'del-a'])
    expect(first.machine.verification.criteria.map((item) => item.subject_id))
      .toEqual(['criterion-b', 'criterion-a'])
    expect(first.machine.claims.claimed_changed_files).toEqual(['src/a.ts', 'src/z.ts'])
    expect(first.machine.claims.claimed_commits).toEqual(['aaaa0000', 'ffff0000'])
  })

  it('accounts for evidence identities that collide only after credential redaction', () => {
    const report = acceptedReport()
    report.criterion_results[0] = {
      ...report.criterion_results[0]!,
      evidence_refs: [
        {
          kind: 'url',
          ref: 'https://example.test/r?access_token=secret-one#same-section',
          label: null,
        },
        {
          kind: 'url',
          ref: 'https://example.test/r?access_token=secret-two#same-section',
          label: null,
        },
      ],
    }

    const summary = createVerifiedDeliverySummary({
      latestAcceptedReport: report,
      currentReport: report,
    })
    const criterion = summary.verification.criteria
      .find((item) => item.subject_id === 'criterion-a')

    expect(criterion?.evidence).toHaveLength(1)
    expect(criterion?.evidence_omitted_count).toBe(1)
    expect(summary.truncation.omitted_items.verification.evidence_references).toBe(1)

    report.criterion_results[0] = {
      ...report.criterion_results[0]!,
      evidence_refs: [
        {
          kind: 'url',
          ref: 'https://example.test/r#access_token=one&section=a%26b',
          label: null,
        },
        {
          kind: 'url',
          ref: 'https://example.test/r#access_token=two&section=a&b',
          label: null,
        },
      ],
    }
    const distinct = createVerifiedDeliverySummary({
      latestAcceptedReport: report,
      currentReport: report,
    }).verification.criteria.find((item) => item.subject_id === 'criterion-a')

    expect(distinct?.evidence).toHaveLength(2)
    expect(distinct?.evidence_omitted_count).toBe(0)
    expect(distinct?.evidence.map((item) => item.evidence_id)).toEqual(expect.arrayContaining([
      expect.stringContaining('section=a%26b'),
      expect.stringContaining('section=a&b'),
    ]))
  })

  it('applies deterministic prose and human budgets with explicit truncation metadata', () => {
    const report = acceptedReport({
      summary: 'A'.repeat(500),
      claims: [{
        id: 'claim-large',
        text: 'B'.repeat(500),
        criterion_id: 'criterion-a',
        deliverable_id: null,
      }],
      gaps: ['C'.repeat(500)],
    })
    const options = {
      textBudgetCharacters: 90,
      maxFieldCharacters: 24,
      maxHumanCharacters: 300,
    }
    const first = generateVerifiedDeliverySummary({
      latestAcceptedReport: report,
      currentReport: report,
    }, options)
    const second = generateVerifiedDeliverySummary({
      latestAcceptedReport: report,
      currentReport: report,
    }, options)

    expect(second).toEqual(first)
    expect(first.machine.truncation).toMatchObject({
      text_budget_characters: 90,
      max_field_characters: 24,
      max_human_characters: 300,
      text_characters_used: 90,
    })
    expect(first.machine.truncation.truncated_fields.length).toBeGreaterThan(0)
    expect(Array.from(first.human).length).toBeLessThanOrEqual(300)
    expect(first.human).toContain('human summary truncated')
  })

  it('bounds max-domain evidence and collection cardinality with exact omission accounting', () => {
    const evidenceRefs = Array.from({ length: 100 }, (_, index) => ({
      kind: 'artifact' as const,
      ref: `${String(index).padStart(3, '0')}-${'x'.repeat(2_044)}`,
      label: null,
    }))
    const deliverables = Array.from({ length: 200 }, (_, index) => ({
      id: `deliverable-${String(index).padStart(3, '0')}`,
      text: `Deliverable ${index}`,
      required: true,
      metadata: {},
    }))
    const criteria = Array.from({ length: 200 }, (_, index) => ({
      id: `criterion-${String(index).padStart(3, '0')}`,
      text: `Criterion ${index}`,
      required: true,
      deliverable_ids: [deliverables[index]?.id ?? 'missing'],
      metadata: {},
    }))
    const report = acceptedReport({
      asked: {
        ...structuredClone(ASKED),
        deliverables,
        acceptance_criteria: criteria,
      },
      delivered_items: deliverables.map((item, index) => ({
        id: `item-${index}`,
        deliverable_id: item.id,
        text: item.text,
        status: 'delivered',
      })),
      deliverable_results: deliverables.map((item) => ({
        ...result('deliverable', item.id, item.text),
        evidence_refs: evidenceRefs,
      })),
      criterion_results: criteria.map((item) => ({
        ...result('criterion', item.id, item.text),
        evidence_refs: evidenceRefs,
      })),
      changed_files: Array.from(
        { length: 1_000 },
        (_, index) => `${String(index).padStart(4, '0')}-${'f'.repeat(2_043)}`,
      ),
    })

    const generated = generateVerifiedDeliverySummary({
      latestAcceptedReport: report,
      currentReport: report,
    }, {
      textBudgetCharacters: 0,
      maxFieldCharacters: 0,
      maxHumanCharacters: 100,
    })
    const includedEvidence = [
      ...generated.machine.verification.deliverables,
      ...generated.machine.verification.criteria,
    ].reduce((total, item) => total + item.evidence.length, 0)

    expect(generated.machine.request.deliverables).toHaveLength(200)
    expect(generated.machine.request.acceptance_criteria).toHaveLength(200)
    expect(includedEvidence).toBeLessThanOrEqual(100)
    expect(generated.machine.truncation.omitted_items.verification.evidence_references)
      .toBe(40_000 - includedEvidence)
    expect(generated.machine.truncation.omitted_items.claims.claimed_changed_files)
      .toBeGreaterThanOrEqual(800)
    expect(Array.from(generated.json)).toHaveLength(
      generated.machine.truncation.machine_characters,
    )
    expect(Array.from(generated.json).length)
      .toBeLessThanOrEqual(generated.machine.truncation.max_machine_characters)

    const tightlyBound = generateVerifiedDeliverySummary({
      latestAcceptedReport: report,
      currentReport: report,
    }, {
      textBudgetCharacters: 0,
      maxFieldCharacters: 0,
      maxHumanCharacters: 100,
      maxMachineCharacters: 64_000,
    })
    expect(Array.from(tightlyBound.json)).toHaveLength(
      tightlyBound.machine.truncation.machine_characters,
    )
    expect(Array.from(tightlyBound.json).length).toBeLessThanOrEqual(64_000)
    expect(tightlyBound.machine.truncation.omitted_items.request.deliverables
      + tightlyBound.machine.truncation.omitted_items.request.acceptance_criteria)
      .toBeGreaterThan(0)
    expect(tightlyBound.machine.request.acceptance_criteria.length)
      .toBeGreaterThan(tightlyBound.machine.request.deliverables.length)
  })

  it('redacts source-authored secrets, strips controls, and never includes raw metadata or output', () => {
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz'
    const report = acceptedReport({
      summary: `Authorization: Bearer ${secret}\u001b[31m DATABASE_URL=postgres://alice:supers3cret@db.example.test/app`,
      claims: [{
        id: 'claim-secret',
        text: `password=hunter2 and ${secret}`,
        criterion_id: 'criterion-a',
        deliverable_id: null,
      }],
      acceptance_note: 'cookie: session=super-secret-cookie',
      criterion_results: acceptedReport().criterion_results.map((item, index) => ({
        ...item,
        note: index === 0 ? `api_key=${secret}` : null,
        evidence_refs: index === 0 ? [
          {
            kind: 'url',
            ref: `https://user:uri-password@example.test/report?access_token=${secret}&signature=uri-signature`,
            label: `Bearer ${secret}`,
          },
          {
            kind: 'url',
            ref: 'https://example.test/r#access%5Ftoken=s%65cret-encoded-frag',
            label: null,
          },
          {
            kind: 'url',
            ref: 'https://example.test/r?access_token=secret-one#section-one',
            label: null,
          },
          {
            kind: 'url',
            ref: 'https://example.test/r?access_token=secret-two#section-two',
            label: null,
          },
          {
            kind: 'url',
            ref: 'https://[invalid]/?access_token=malformed-secret',
            label: null,
          },
          {
            kind: 'url',
            ref: 'ftp://alice:ftp-secret@example.test/path',
            label: null,
          },
          {
            kind: 'url',
            ref: '//alice:scheme-secret@example.test/path',
            label: null,
          },
          {
            kind: 'url',
            ref: '%2F%2Falice%3Aencoded-scheme-secret%40example.test%2Fpath',
            label: null,
          },
          {
            kind: 'url',
            ref: 'https%3A%2F%2Falice%3Afully-encoded-secret%40example.test%2Fpath',
            label: null,
          },
          {
            kind: 'url',
            ref: 'https://[invalid]/?access%5Ftoken=encoded-malformed-secret',
            label: null,
          },
          {
            kind: 'url',
            ref: 'data:text/plain,https%3A%2F%2Falice%3Adata-secret%40example.test',
            label: null,
          },
        ] : item.evidence_refs,
      })),
      gaps: [`client_secret=${secret}`],
    })
    report.asked.deliverables[0].metadata = {
      secret,
      raw_output: 'raw command output that must be omitted',
    }

    const generated = generateVerifiedDeliverySummary({
      latestAcceptedReport: report,
      currentReport: report,
    })
    const combined = `${generated.human}\n${generated.json}`

    expect(combined).not.toContain(secret)
    expect(combined).not.toContain('hunter2')
    expect(combined).not.toContain('super-secret-cookie')
    expect(combined).not.toContain('uri-password')
    expect(combined).not.toContain('uri-signature')
    expect(combined).not.toContain('supers3cret')
    expect(combined).not.toContain('malformed-secret')
    expect(combined).not.toContain('ftp-secret')
    expect(combined).not.toContain('scheme-secret')
    expect(combined).not.toContain('encoded-scheme-secret')
    expect(combined).not.toContain('fully-encoded-secret')
    expect(combined).not.toContain('encoded-malformed-secret')
    expect(combined).not.toContain('data-secret')
    expect(decodeURIComponent(combined)).not.toContain('secret-encoded-frag')
    expect(combined).not.toContain('metadata-secret')
    expect(combined).not.toContain('raw command output that must be omitted')
    expect(combined).not.toMatch(/\u001b/)
    expect(combined).toContain('[REDACTED]')
    expect(combined).toContain('postgres://[REDACTED]@db.example.test/app')
    const urlEvidence = generated.machine.verification.criteria
      .flatMap((item) => item.evidence)
      .filter((item) => item.kind === 'url')
      .map((item) => item.evidence_id)
    expect(urlEvidence).toHaveLength(5)
    expect(urlEvidence.filter((item) => item === '[REDACTED_UNSAFE_URL]')).toHaveLength(1)
    expect(urlEvidence).toEqual(expect.arrayContaining([
      expect.stringContaining('#section-one'),
      expect.stringContaining('#section-two'),
    ]))
    const redactedCriterion = generated.machine.verification.criteria
      .find((item) => item.subject_id === 'criterion-a')
    expect(redactedCriterion?.evidence_omitted_count).toBe(6)
    expect(generated.machine.redaction_policy).toMatchObject({
      raw_artifact_content_included: false,
      raw_command_output_included: false,
      contract_metadata_included: false,
      unsupported_url_references_replaced: true,
    })
    expect(generated.machine.redaction_policy.redactions_applied).toBeGreaterThanOrEqual(6)
  })
})
