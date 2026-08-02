#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BROWSER_BASELINE_SCHEMA_VERSION,
  PERFORMANCE_SURFACES,
  RESPONSIVE_VIEWPORTS,
  canonicalJson,
  checkedBudget,
  percentile,
  redactEvidence,
  resolveApprovedEvidencePath,
  validateBaselineAgainstCaptures,
  verifiableDocumentDigest,
} from './lib/browser-quality.mjs'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const parseArgs = (argv) => {
  let output
  const observations = []
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--output' && argv[index + 1]) output = resolve(argv[++index])
    else observations.push(argv[index])
  }
  if (!output || observations.length < 3) {
    throw new Error('usage: create-browser-baseline.mjs --output <path> <observation...> (at least three)')
  }
  return { output, observations }
}

const fileDigest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')

const loadObservation = (path) => {
  const approvedPath = resolveApprovedEvidencePath(repositoryRoot, path)
  const document = JSON.parse(readFileSync(approvedPath, 'utf8'))
  if (document.sha256 !== verifiableDocumentDigest(document)) throw new Error(`${approvedPath}: evidence digest is invalid`)
  if (canonicalJson(document) !== canonicalJson(redactEvidence(document))) throw new Error(`${approvedPath}: evidence is not redacted`)
  if (document.evidence_boundary?.qa_013_closure_permitted !== false) throw new Error(`${approvedPath}: QA-013 boundary changed`)
  for (const viewport of document.viewports ?? []) {
    if (viewport.console_errors?.length || viewport.page_errors?.length || viewport.failed_requests?.length) {
      throw new Error(`${approvedPath}: runtime/network errors cannot enter the performance baseline`)
    }
    if (viewport.readiness?.graph_agents_rendered !== 18
      || viewport.readiness?.transcript_events_rendered < 250
      || viewport.readiness?.search_matches_rendered !== 5) {
      throw new Error(`${approvedPath}: scale/readiness assertions did not pass`)
    }
    for (const surface of PERFORMANCE_SURFACES) {
      const metric = viewport.performance?.[surface]
      if (!Number.isFinite(metric?.observed_ms) || metric.observed_ms < 0
        || metric.budget_ms !== null || metric.budget_source !== 'observation_only') {
        throw new Error(`${approvedPath}: ${viewport.id} ${surface} is not an unbiased observation`)
      }
    }
  }
  return { path: approvedPath, document, file_sha256: fileDigest(approvedPath) }
}

const main = () => {
  const options = parseArgs(process.argv.slice(2))
  const captures = options.observations.map(loadObservation)
  const source = captures[0].document.source
  for (const capture of captures.slice(1)) {
    if (capture.document.source.commit !== source.commit
      || canonicalJson(capture.document.source.artifact_identity) !== canonicalJson(source.artifact_identity)) {
      throw new Error('all observations must bind to the same source commit and build artifacts')
    }
  }
  const viewports = RESPONSIVE_VIEWPORTS.map((viewport) => ({
    id: viewport.id,
    width: viewport.width,
    height: viewport.height,
    performance: Object.fromEntries(PERFORMANCE_SURFACES.map((surface) => {
      const samples = captures.map((capture) => {
        const observed = capture.document.viewports.find((candidate) => candidate.id === viewport.id)
          ?.performance?.[surface]?.observed_ms
        if (!Number.isFinite(observed)) throw new Error(`missing ${viewport.id} ${surface} observation`)
        return observed
      })
      const observedP95 = percentile(samples, 0.95)
      return [surface, {
        samples_ms: samples,
        observed_p95_ms: observedP95,
        ...checkedBudget(surface, observedP95),
      }]
    })),
  }))
  const baseline = {
    schema_version: BROWSER_BASELINE_SCHEMA_VERSION,
    backlog_item: 'QA-015',
    status: 'checked_observation',
    budget_source: 'checked_observation',
    source: {
      commit: source.commit,
      artifact_identity: source.artifact_identity,
      node: source.node,
      browser_surface: 'standalone_chromium_cdp_fallback',
    },
    methodology: {
      runs: captures.length,
      scenario: 'authenticated public-API fixture; 18 rendered graph agents; 250 seeded events plus provider lifecycle; exactly five rendered search matches',
      budget_policy: 'minimum of explicit beta experience ceiling and max(2x observed p95, observed p95 + 150ms)',
      scope: 'single-host engineering regression baseline; QA-013/QA-014 remain open',
    },
    capture_artifacts: captures.map((capture) => ({
      path: relative(repositoryRoot, capture.path),
      sha256: capture.document.sha256,
      file_sha256: capture.file_sha256,
    })),
    viewports,
  }
  baseline.sha256 = verifiableDocumentDigest(baseline)
  const recomputationErrors = validateBaselineAgainstCaptures(baseline, captures.map((capture) => capture.document))
  if (recomputationErrors.length) throw new Error(`generated baseline failed recomputation: ${recomputationErrors.join('; ')}`)
  mkdirSync(dirname(options.output), { recursive: true })
  writeFileSync(options.output, `${JSON.stringify(baseline, null, 2)}\n`, { mode: 0o600 })
  console.log(`QA browser performance baseline: ${options.output}`)
  console.log(`baseline sha256: ${baseline.sha256}`)
}

main()
